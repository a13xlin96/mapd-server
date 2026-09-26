const {normalizePlaceName: normalize} = require('../lib/placeNameNormalize');

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;
const unique = values => [...new Set(values.filter(Boolean))];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Country names come from the runtime's region data, never venue translations
// or model-supplied aliases. ISO short_name also bridges localized Google rows.
const regions = new Intl.DisplayNames(['en'], {type:'region', fallback:'none'});
const localizedRegions = ['zh-Hant','zh-Hans','ja','ko'].map(locale=>new Intl.DisplayNames([locale],{type:'region',fallback:'none'}));
const countryCodes = new Map();
for (let a=65; a<=90; a++) for (let b=65; b<=90; b++) {
  const code = String.fromCharCode(a,b);
  for (const names of [regions,...localizedRegions]) {
    const name=names.of(code);
    if (name) countryCodes.set(normalize(name),code);
  }
}
for (const [name,code] of Object.entries({usa:'US',us:'US','united states of america':'US',uk:'GB','great britain':'GB'})) countryCodes.set(name,code);
const countryNames = [...countryCodes.keys()].sort((a,b)=>b.length-a.length);
const countryCode = value => countryCodes.get(normalize(value)) || (/^[a-z]{2}$/i.test(value || '') && regions.of(value.toUpperCase()) ? value.toUpperCase() : '');
function countryAliases(values) {
  const codes = unique(values.map(countryCode));
  return unique([...values.map(normalize), ...codes.flatMap(code => [normalize(code),normalize(regions.of(code)), ...[...countryCodes].filter(([,c])=>c===code).map(([n])=>n)])]);
}

function boundary(text, start, end, phrase) {
  // CJK administrative components may be contiguous. Latin phrases and digits
  // still need real boundaries: York != Yorkshire, US != Russia, 1 != 12.
  const adjoining = char => CJK.test(char || '') || /\d/.test(char || '');
  return (!WORD.test(text[start-1] || '') || (CJK.test(phrase[0]) && adjoining(text[start-1]))) &&
    (!WORD.test(text[end] || '') || (CJK.test(phrase.at(-1)) && adjoining(text[end])));
}
function hasPhrase(text, phrase) {
  if (!phrase) return false;
  let start = text.indexOf(phrase);
  while (start>=0) {
    if (boundary(text,start,start+phrase.length,phrase)) return true;
    start = text.indexOf(phrase,start+1);
  }
  return false;
}
function removePhrase(text, phrase) {
  if (!phrase) return text;
  return text.replace(new RegExp(escape(phrase),'gu'), (match,index) => boundary(text,index,index+match.length,match) ? ' ' : match);
}
const STREET_MARKER = /\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|highway|hwy|way|route|rue|chemin|impasse|allee|platz|gasse)\b|(?:strasse|straße)\b|[街路巷弄號丁目番地]/iu;
function stripPostal(value) {
  return String(value || '').split(/([,，;\n])/).map(part=>{
    let text=part.replace(/〒\s*/g,'').replace(/\b\d{3}-\d{4}\b/g,' ')
      .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,' ')
      .replace(/^\s*\d{3,6}(?=[\p{Script=Han}]+[市縣県])/u,'');
    // European postal-locality segments can omit the space. Strip only a
    // five-digit prefix followed by a complete locality phrase, never a route.
    const prefix=text.match(/^\s*\d{5}\s*([\p{L}\p{M}][\p{L}\p{M}\s'’\-]*)$/u);
    if (prefix && !STREET_MARKER.test(prefix[1])) text=prefix[1];
    if (!STREET_MARKER.test(text)) text=text.replace(/\b\d{5}(?:-\d{4})?\s*$|\s+\d{3}\s*$/g,'');
    return text;
  }).join('');
}
function areaAliases(values,kind) {
  const aliases = unique(values.map(normalize));
  if (kind==='locality' || kind==='fallback') {
    for (const [short,long] of [['nyc','new york'],['sf','san francisco'],['la','los angeles']]) {
      if (aliases.includes(short) || aliases.includes(long)) aliases.push(short,long);
    }
  }
  return unique(aliases);
}
function fallbackGeography(value,name) {
  const parts = String(value || '').split(/[,，;\n]/).map(p=>normalize(stripPostal(p))).filter(Boolean);
  const groups = [];
  // Country may come first or last. Do not interpret an interior state such as
  // Georgia as a second country in a US address.
  for (const index of new Set([parts.length-1,0])) {
    const part = parts[index];
    if (!part) continue;
    const match = countryNames.find(alias => part===alias ||
      ((part.endsWith(alias) || part.startsWith(alias)) && hasPhrase(part,alias)));
    if (match) {
      groups.push({kind:'country',aliases:countryAliases([match])});
      parts[index] = normalize(stripPostal(removePhrase(part,match)));
      break;
    }
  }
  for (const part of parts) {
    if (!part || (name && hasPhrase(part,normalize(name)))) continue;
    // Retain CJK administrative prefixes before the street begins.
    const prefix = part.match(/^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+?[市縣県都府區区郡里])+/u)?.[0];
    if (prefix) {
      for (const area of prefix.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+?[市縣県都府區区郡里]/gu)) groups.push({kind:'fallback',aliases:[area]});
      continue;
    }
    if (/\d/.test(part) || STREET_MARKER.test(part)) continue;
    groups.push({kind:'fallback',aliases:areaAliases([part],'fallback')});
  }
  return groups;
}
function geography(candidate) {
  const components = Array.isArray(candidate.address_components) ? candidate.address_components : [];
  const groups = [];
  for (const c of components) {
    const types = Array.isArray(c?.types) ? c.types : [];
    const kind = types.find(t=>t==='country' || /^(?:locality|postal_town|neighborhood|sublocality(?:_level_\d+)?|administrative_area_level_\d+)$/.test(t));
    if (!kind) continue;
    const values = [c.long_name,c.short_name].filter(v=>typeof v==='string' && v.trim());
    const aliases = kind==='country' ? countryAliases(values) : areaAliases(values,kind);
    if (aliases.length) groups.push({kind,aliases});
  }
  const fallback = fallbackGeography(candidate.formatted_address,candidate.name);
  if (!groups.some(g=>g.kind!=='country')) groups.push(...fallback.filter(g=>g.kind!=='country'));
  if (!groups.some(g=>g.kind==='country')) groups.push(...fallback.filter(g=>g.kind==='country'));
  return {groups,components,rawAddress:candidate.formatted_address,address:normalize(candidate.formatted_address),country:groups.find(g=>g.kind==='country')};
}
function matchesGeography(hint,groups) {
  const value = normalize(hint);
  if (!value) return true;
  // Cover the entire hint with whole components, each at most once. Multiword
  // cities stay intact; a wrong state/district/country leaves unmatched text.
  const visit = (rest,used) => {
    if (!rest) return true;
    return groups.some((group,index) => !used.has(index) && group.aliases.some(alias =>
      rest.startsWith(alias) && boundary(rest,0,alias.length,alias) &&
      visit(rest.slice(alias.length).trim(),new Set([...used,index]))));
  };
  return visit(value,new Set());
}
function matchesCountry(hint,profile) {
  if (!hint) return true;
  return !!profile.country?.aliases.includes(normalize(hint));
}
function geographyMention(text,profile) {
  const aliases=profile.groups.flatMap(g=>g.aliases);
  if (aliases.some(alias=>!CJK.test(alias) && alias.length>=3 && hasPhrase(text,alias))) return true;
  // Structural CJK boundaries permit contiguous address components, but are
  // not semantic evidence in prose: 日本料理 / 日本酒 do not locate a venue.
  // Require the whole contiguous run to be geography or a matching address.
  return (text.match(/[\p{L}\p{N}]+/gu) || []).some(run=>
    aliases.some(alias=>CJK.test(alias) && hasPhrase(run,alias)) &&
    (matchesGeography(normalize(stripPostal(run)),profile.groups) ||
      (/\d/.test(run) && addressEvidence(run,profile).matches)));
}
function streetText(value,profile) {
  let text = String(value || '').split(/[,，;\n]/).map(part=>{
    let segment=normalize(stripPostal(part));
    for (const alias of profile.country?.aliases || []) segment=removePhrase(segment,alias);
    // Country-first addresses may put country and postal-locality together.
    return normalize(stripPostal(segment));
  }).join(' ');
  const aliases = unique(profile.groups.flatMap(g=>g.aliases)).sort((a,b)=>b.length-a.length);
  for (const alias of aliases) text = removePhrase(text,alias);
  for (const c of profile.components) if (c.types?.includes('postal_code')) {
    for (const alias of unique([c.long_name,c.short_name].map(normalize))) text=removePhrase(text,alias);
  }
  return text.replace(/\b(?:no|number)\b/g,' ').replace(/\s+/g,' ').trim();
}
function addressEvidence(hint,profile) {
  if (!hint) return {matches:false,conflict:false};
  const hintGroups = fallbackGeography(hint);
  const geoConflict = hintGroups.some(g=>g.kind==='country'
    ? profile.country && !g.aliases.some(a=>profile.country.aliases.includes(a))
    : !g.aliases.some(a=>matchesGeography(a,profile.groups)));
  const wanted = streetText(hint,profile), actual = streetText(profile.rawAddress,profile);
  const numbers = text => text.match(/\d+[a-z]?(?![a-z])/g) || [];
  const wantedNumbers = numbers(wanted), actualNumbers = numbers(actual);
  const numberConflict = wantedNumbers.length>0 && actualNumbers.length>0 &&
    wantedNumbers.join('|')!==actualNumbers.join('|');
  const compact = text => text.replace(/\s/g,'');
  const meaningful = /\p{L}/u.test(wanted) && wanted.length>=3;
  const matches = !geoConflict && !numberConflict && meaningful &&
    (compact(wanted)===compact(actual) || hasPhrase(profile.address,normalize(hint)));
  return {matches:!!matches,conflict:!!(geoConflict || numberConflict)};
}

const GENERIC_NAME = new Set('the and of a an at in restaurant cafe coffee bar kitchen sushi ramen chicken house grill shop food bakery bistro dining blue red green golden new old best good great little big'.split(' '));
function nameEvidence(wanted,actual,profile,similarity) {
  const a=normalize(wanted), b=normalize(actual);
  if (!a || !b) return {score:0,partial:false};
  if (a===b) return {score:1,partial:false};
  // A contiguous CJK suffix may describe a branch or venue type. It is never
  // equivalent to the complete name and cannot authorize automatic saving.
  const [short,long]=[a,b].sort((x,y)=>x.length-y.length);
  if (CJK.test(short) && !short.includes(' ') && short.length>=3 && long.startsWith(short) && short.length/long.length>=0.6) {
    return {score:Math.min(0.64,short.length/long.length),partial:true};
  }
  const score=similarity(a,b), aa=a.split(' '), bb=b.split(' ');
  const distinctive = unique(aa.filter(word=>bb.includes(word) && !GENERIC_NAME.has(word) &&
    word.length>=3 && !profile.groups.some(g=>g.aliases.some(alias=>hasPhrase(alias,word)))));
  const meaningful = distinctive.length>=2 || distinctive.some(word=>word.length>=5) ||
    (aa.length<=2 && bb.length<=2 && distinctive.some(word=>word.length>=4)) ||
    (distinctive.length>0 && short.split(' ').length>=2 && hasPhrase(long,short));
  return {score,partial:score>=0.5 && meaningful};
}
function compatibleVariants(base,variant) {
  const a=geography(base),b=geography(variant);
  if (a.country && b.country && !a.country.aliases.some(x=>b.country.aliases.includes(x))) return false;
  const latin=aliases=>aliases.filter(x=>/^[a-z\s]+$/.test(x));
  for (const group of a.groups.filter(g=>g.kind==='fallback')) {
    const comparable=b.groups.filter(g=>g.kind!=='country').flatMap(g=>latin(g.aliases));
    if (latin(group.aliases).length && comparable.length && !group.aliases.some(x=>comparable.includes(x))) return false;
  }
  // Compare component values in the same script. Different scripts can be
  // translations; their place ID and coordinates must still agree upstream.
  for (const group of a.groups.filter(g=>g.kind!=='fallback' && g.kind!=='country')) {
    const other=b.groups.find(g=>g.kind===group.kind);
    if (!other || group.aliases.some(x=>other.aliases.includes(x))) continue;
    if (latin(group.aliases).length && latin(other.aliases).length) return false;
    if (group.aliases.every(x=>CJK.test(x)) && other.aliases.every(x=>CJK.test(x))) return false;
  }
  return true;
}

module.exports={hasPhrase,removePhrase,geography,matchesGeography,matchesCountry,geographyMention,addressEvidence,nameEvidence,compatibleVariants};
