const {rankPlaces, validCoordinates} = require('./confidence');
const {distanceKm} = require('../lib/geo');
const context = require('../lib/jobContext');

// This selects a Google response language, not a translation or an assertion
// about a venue's identity. Recovered results still go through normal ranking.
function matchingLanguage(place, results) {
  const text = [place.name, place.city, place.address, place.country].filter(Boolean).join(' ');
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
  const scripts = {ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    'zh-TW': /\p{Script=Han}/u, 'zh-CN': /\p{Script=Han}/u, ko: /\p{Script=Hangul}/u,
    th: /\p{Script=Thai}/u, ar: /\p{Script=Arabic}/u, ru: /\p{Script=Cyrillic}/u,
    uk: /\p{Script=Cyrillic}/u, el: /\p{Script=Greek}/u, he: /\p{Script=Hebrew}/u,
    hi: /\p{Script=Devanagari}/u};
  const script = scripts[languageCode];
  return results.some(row => (script.test(place.name || '') && !script.test(row.name || '')) ||
    (script.test([place.city, place.address, place.country].filter(Boolean).join(' ')) && !script.test(row.formatted_address || '')));
}

function createPlaceMatcher(search, {maxLocalizedLookups = 6} = {}) {
  const localizedSearches = new Map();
  return async function matchPlace(results, evidence, extractedPlace, query) {
    const primary = rankPlaces(results, evidence, extractedPlace);
    if (primary.place || !results.length) return primary;
    const languageCode = matchingLanguage(extractedPlace, results);
    if (!languageCode || !hasScriptMismatch(extractedPlace, results, languageCode)) return primary;
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
