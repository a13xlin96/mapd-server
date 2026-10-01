const {rankPlaces, validCoordinates} = require('./confidence');
const {distanceKm} = require('../lib/geo');
const context = require('../lib/jobContext');
const {geography, matchesGeography, matchesCountry, addressEvidence} = require('./matchingEvidence');
const {normalizePlaceName} = require('../lib/placeNameNormalize');

// Horn vowels and Vietnamese tone combinations are stronger signals than
// accents shared by ordinary French, Spanish, or Portuguese venue names.
const VI_DISTINCTIVE = /[ơư\u1ea0-\u1ef9]/iu;
const VI_SHARED_LETTERS = /[ăâđêô]/iu;
const nfc = value => String(value || '').normalize('NFC');
function vietnamSpelling(value) {
  const text = nfc(value);
  return VI_DISTINCTIVE.test(text) || VI_SHARED_LETTERS.test(text);
}
const vietnamCountry = value => /^(?:vn|vi[eệ]t\s*nam)$/iu.test(nfc(value).trim());
function vietnamAddress(value) {
  const parts = nfc(value).split(/[,，;\n]/).map(part => part.trim()).filter(Boolean);
  return vietnamCountry(parts[0]) || vietnamCountry(parts.at(-1));
}
function vietnamResult(row) {
  const countries = (Array.isArray(row.address_components) ? row.address_components : [])
    .filter(component => Array.isArray(component?.types) && component.types.includes('country'));
  return countries.length
    ? countries.some(component => vietnamCountry(component.short_name) || vietnamCountry(component.long_name))
    : vietnamAddress(row.formatted_address);
}

function vietnamFieldMismatch(source, response, row) {
  const wanted = nfc(source).trim().toLowerCase();
  const actual = nfc(response).trim().toLowerCase();
  if (wanted === actual || !vietnamSpelling(wanted)) return false;
  // Shared circumflexes can support the source after Vietnam is established,
  // but a different French name such as Pâtisserie does not prove Vietnamese.
  return !VI_DISTINCTIVE.test(actual) && !(/[ăđ]/iu.test(actual) && vietnamResult(row));
}

// This selects a Google response language, not a translation or an assertion
// about a venue's identity. Recovered results still go through normal ranking.
function matchingLanguage(place, results) {
  const text = nfc([place.name, place.city, place.address, place.country].filter(Boolean).join(' '));
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Han}/u.test(text)) {
    const region = [text, ...results.map(r => r.formatted_address || '')].join(' ');
    if (/\b(?:japan|tokyo|kyoto|osaka)\b|日本|東京都|京都|大阪|北海道|県/iu.test(region)) return 'ja';
    if (/\b(?:taiwan|taipei|hong kong)\b|台灣|臺灣|新北|臺北|台北|香港|雞|號|區|灣/iu.test(region)) return 'zh-TW';
    return 'zh-CN';
  }
  if (/\p{Script=Thai}/u.test(text)) return 'th';
  if (/\p{Script=Arabic}/u.test(text)) return 'ar';
  if (/\p{Script=Cyrillic}/u.test(text)) return /[іїєґ]/iu.test(text) ? 'uk' : 'ru';
  if (/\p{Script=Greek}/u.test(text)) return 'el';
  if (/\p{Script=Hebrew}/u.test(text)) return 'he';
  if (/\p{Script=Devanagari}/u.test(text)) return 'hi';
  if (vietnamCountry(place.country) || vietnamAddress(place.city) || vietnamAddress(place.address) ||
    VI_DISTINCTIVE.test(text) || (VI_SHARED_LETTERS.test(text) && results.some(vietnamResult))) return 'vi';
  return null;
}

function mergeLocalizedResults(primary, localized) {
  const byId = new Map();
  for (const row of primary.slice(0, 5)) {
    if (row.place_id && row.name && validCoordinates(row)) byId.set(row.place_id, {...row});
  }
  for (const row of localized.slice(0, 5)) {
    if (!row.place_id || !row.name || !validCoordinates(row)) continue;
    const original = byId.get(row.place_id);
    if (!original) { byId.set(row.place_id, {...row}); continue; }
    const a = original.geometry?.location || original, b = row.geometry?.location || row;
    // A stale/malformed localized row must not lend its address to another
    // location, even if an upstream response happens to reuse an ID.
    if (distanceKm(a.lat, a.lng, b.lat, b.lng) > 0.1) continue;
    original._matchingVariants = [row];
  }
  return [...byId.values()];
}

function hasScriptMismatch(place, results, languageCode) {
  if (languageCode === 'vi') {
    // Country/ISO evidence selects the language but cannot alone establish a
    // response-language mismatch. Compare each field with its counterpart;
    // generic accents alone do not establish a Vietnamese response.
    return results.some(row =>
      vietnamFieldMismatch(place.name, row.name, row) ||
      vietnamFieldMismatch([place.city, place.address, place.country].filter(Boolean).join(' '), row.formatted_address, row));
  }
  const scripts = {ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    'zh-TW': /\p{Script=Han}/u, 'zh-CN': /\p{Script=Han}/u, ko: /\p{Script=Hangul}/u,
    th: /\p{Script=Thai}/u, ar: /\p{Script=Arabic}/u, ru: /\p{Script=Cyrillic}/u,
    uk: /\p{Script=Cyrillic}/u, el: /\p{Script=Greek}/u, he: /\p{Script=Hebrew}/u,
    hi: /\p{Script=Devanagari}/u};
  const script = scripts[languageCode];
  return results.some(row => {
    const profile=geography(row);
    // A single native-script character in a street number ("10號") or venue
    // name says nothing about the response language of the city. Compare the
    // geographic fields independently so mixed-script Maps rows can recover.
    const areas=profile.groups.filter(group=>group.kind!=='country').flatMap(group=>group.originalAliases || group.aliases);
    return (script.test(place.name || '') && !script.test(row.name || '')) ||
      (script.test(place.city || '') && !areas.some(area=>script.test(area))) ||
      (script.test(place.country || '') && !script.test(row.address_components?.find?.(c=>Array.isArray(c?.types) && c.types.includes('country'))?.long_name || row.formatted_address || '')) ||
      (script.test(place.address || '') && !script.test(row.formatted_address || ''));
  });
}

function hasVietnameseNameRecovery(place, results) {
  // Captions often romanize Vietnamese names or use unaccented handles.
  // Two shared name words (or an explicit account clue) plus a corroborated
  // Vietnamese city justify ONE local-language lookup, not an identity claim.
  // Country alone and unrelated names do not trigger this extra paid search.
  if (!place.city) return false;
  const wanted=new Set(normalizePlaceName(place.name).split(' ').filter(Boolean));
  return results.some(row=>{
    const profile=geography(row);
    if (profile.countryCode!=='VN' || !matchesGeography(place.city,profile.groups)) return false;
    if (!matchesCountry(place.country,profile) || addressEvidence(place.address,profile).reasons.includes('country_conflict')) return false;
    if (VI_DISTINCTIVE.test(nfc(row.name)) || /[ăđ]/iu.test(nfc(row.name))) return false;
    if (place.source==='handle' && typeof place.handle==='string' && place.handle.trim()) return true;
    const actual=new Set(normalizePlaceName(row.name).split(' ').filter(Boolean));
    const common=[...wanted].filter(word=>actual.has(word) && word.length>=3);
    return common.length>=2 && common.length/Math.max(wanted.size,actual.size)>=0.3;
  });
}

function createPlaceMatcher(search, {maxLocalizedLookups = 6} = {}) {
  const localizedSearches = new Map();
  return async function matchPlace(results, evidence, extractedPlace, query) {
    const primary = rankPlaces(results, evidence, extractedPlace);
    if (primary.place || !results.length) return primary;
    const vietnameseNameRecovery=hasVietnameseNameRecovery(extractedPlace,results);
    const languageCode = matchingLanguage(extractedPlace, results) || (vietnameseNameRecovery ? 'vi' : null);
    if (!languageCode || (!hasScriptMismatch(extractedPlace, results, languageCode) && !(languageCode==='vi' && vietnameseNameRecovery))) return primary;
    const key = JSON.stringify([query, languageCode]);
    if (!localizedSearches.has(key)) {
      if (localizedSearches.size >= maxLocalizedLookups) return primary;
      await context.assertActive();
      localizedSearches.set(key, search(query, undefined, undefined, {languageCode}));
    }
    try {
      const localized = await localizedSearches.get(key);
      await context.assertActive();
      const recovered = rankPlaces(mergeLocalizedResults(results, localized), evidence, extractedPlace);
      // Language recovery is useful evidence, but always let the user approve
      // it before any pin or source is written (including existing pins).
      return recovered.place ? {...recovered, requiresSelection: true} : recovered;
    } catch (error) {
      if (error.code === 'attempt_stopped' || context.current()?.signal?.aborted) throw error;
      return {...primary, localizationFailure: error};
    }
  };
}

module.exports = {createPlaceMatcher, matchingLanguage, mergeLocalizedResults};
