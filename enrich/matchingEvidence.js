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
// Add only the needed Vietnam spelling. Importing every Vietnamese country
// name would collide with ISO AO/BI and turn cuisine words into geography.
for (const [name,code] of Object.entries({usa:'US',us:'US','united states of america':'US',uk:'GB','great britain':'GB','viet nam':'VN'})) countryCodes.set(name,code);
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
const VIETNAM_LOCALITIES = [
  ['ho chi minh','ho chi minh city','hcmc','hcm','tp ho chi minh','thanh pho ho chi minh','sai gon','saigon'],
  ['ha noi','hanoi','ha noi city','tp ha noi','thanh pho ha noi'],
];
function stripPostal(value,country,components=[]) {
  const parts=String(value || '').split(/([,，;\n])/);
  let finalLocality=parts.length-1;
  while(finalLocality>=0 && (!parts[finalLocality].trim() || /^[,，;\n]$/.test(parts[finalLocality]) || countryCode(parts[finalLocality].trim()))) finalLocality--;
  return parts.map((part,index)=>{
    let text=part.replace(/〒\s*/g,'').replace(/\b\d{3}-\d{4}\b/g,' ')
      .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,' ')
      .replace(/^\s*\d{3,6}(?=[\p{Script=Han}]+[市縣県])/u,'');
    // European postal-locality segments can omit the space. Strip only a
    // five-digit prefix followed by a complete locality phrase, never a route.
    const prefix=text.match(/^\s*\d{5}\s*([\p{L}\p{M}][\p{L}\p{M}\s'’\-]*)$/u);
    if (prefix && !STREET_MARKER.test(prefix[1])) text=prefix[1];
    if (!STREET_MARKER.test(text)) {
      // Older Vietnam listings can retain six-digit postal codes. Strip one
      // only after a complete vetted locality in a Vietnam address; never
      // erase a six-digit house number or a similarly named route.
      const postalLocality=text.match(/^\s*(.+?)\s+\d{6}\s*$/u);
      // A known six-digit house number disables this heuristic for both
      // candidate and hint. The hint's differing number must remain a
      // conflict even when the structured route is missing.
      const routeEvidence=postalLocality && components.some(c=>Array.isArray(c?.types) &&
        ((c.types.includes('route') && [c.long_name,c.short_name].some(v=>v && normalize(v)===normalize(postalLocality[1]))) ||
         (c.types.includes('street_number') && [c.long_name,c.short_name].some(v=>v && /^\d{6}$/.test(String(v).trim())))));
      if (country==='VN' && index===finalLocality && postalLocality && !routeEvidence && VIETNAM_LOCALITIES.some(names=>names.includes(normalize(postalLocality[1])))) text=postalLocality[1];
      text=text.replace(/\b\d{5}(?:-\d{4})?\s*$|\s+\d{3}\s*$/g,'');
    }
    return text;
  }).join('');
}
function areaAliases(values,kind,country,isLocality=kind==='locality') {
  const aliases = unique(values.map(normalize));
  // 台 / 臺 are alternative spellings in Taiwan's administrative names.
  // Scope this equivalence to geography; do not rewrite business identities.
  if (country==='TW' && /^(?:locality|postal_town|administrative_area_level_\d+|sublocality(?:_level_\d+)?|fallback)$/.test(kind)) {
    for (const value of [...aliases]) if (/[市縣區鄉鎮里]$/u.test(value)) aliases.push(value.replace(/臺/g,'台'),value.replace(/台/g,'臺'));
  }
  if (kind==='locality' || kind==='fallback') {
    for (const [short,long] of [['nyc','new york'],['sf','san francisco'],['la','los angeles']]) {
      if (aliases.includes(short) || aliases.includes(long)) aliases.push(short,long);
    }
  }
  // New York is also a state. Extend this spelling only for a US locality,
  // never an administrative component or a later cached address region.
  const newYork=['new york','nyc','new york city'];
  if (country==='US' && isLocality && newYork.some(name=>aliases.includes(name))) aliases.push(...newYork);
  // These are locality spellings, never venue-name translations. Require
  // Google's country evidence so "HCM" elsewhere cannot borrow Vietnam's city.
  if (country==='VN') {
    if (['locality','administrative_area_level_1','fallback'].includes(kind)) {
      for (const names of VIETNAM_LOCALITIES) if (names.some(name=>aliases.includes(name))) aliases.push(...names);
    }
    if (/^(?:neighborhood|sublocality(?:_level_\d+)?|administrative_area_level_[2345]|fallback)$/.test(kind)) {
      for (const value of [...aliases]) {
        const ward=value.match(/^phuong (.+)$|^(.+) ward$/u);
        const name=ward?.[1] || ward?.[2];
        if (name) aliases.push(name,`phuong ${name}`,`${name} ward`);
      }
    }
  }
  return unique(aliases);
}
function areaGroup(values,kind,country,isLocality) {
  // Preserve the pre-existing NYC/SF/LA policy. Confirmation is new only for
  // the additional equivalences, not a change to those mature paths.
  return {kind,aliases:areaAliases(values,kind,country,isLocality),originalAliases:areaAliases(values,kind)};
}
function fallbackGeography(value,name,country,components=[]) {
  const rawParts=String(value || '').split(/[,，;\n]/).map(p=>p.trim()).filter(Boolean);
  // Establish only an explicit edge country before country-specific postal
  // normalization. Structured country evidence still wins in geography().
  const postalCountry=country || countryCode(rawParts.at(-1)) || countryCode(rawParts[0]);
  const parts = stripPostal(value,postalCountry,components).split(/[,，;\n]/).map(normalize).filter(Boolean);
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
      country=countryCode(match);
      parts[index] = normalize(stripPostal(removePhrase(part,match)));
      break;
    }
  }
  for (const [index,part] of parts.entries()) {
    if (!part || (name && hasPhrase(part,normalize(name)))) continue;
    // Retain CJK administrative prefixes before the street begins.
    const prefix = part.match(/^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+?[市縣県都府區区郡里])+/u)?.[0];
    if (prefix) {
      for (const area of prefix.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+?[市縣県都府區区郡里]/gu)) groups.push(areaGroup([area],'fallback',country));
      continue;
    }
    if (/\d/.test(part) || STREET_MARKER.test(part)) continue;
    // A cached US city-first address may follow New York with NY. Other
    // trailing regions (e.g. country-first New York, Albany) are ambiguous.
    const cityPosition=!groups.some(g=>g.kind!=='country') &&
      parts.slice(index+1).filter(Boolean).every(p=>p==='ny' || p==='new york');
    groups.push(areaGroup([part],'fallback',country,cityPosition));
  }
  return groups;
}
function geography(candidate) {
  const components = Array.isArray(candidate.address_components) ? candidate.address_components : [];
  const groups = [];
  const countryComponent=components.find(c=>Array.isArray(c?.types) && c.types.includes('country'));
  const typedCountry=countryCode(countryComponent?.short_name) || countryCode(countryComponent?.long_name);
  const fallback=fallbackGeography(candidate.formatted_address,candidate.name,typedCountry,components);
  const country=typedCountry || fallback.find(g=>g.kind==='country')?.aliases.map(countryCode).find(Boolean);
  for (const c of components) {
    const types = Array.isArray(c?.types) ? c.types : [];
    const kind = types.find(t=>t==='country' || /^(?:locality|postal_town|neighborhood|sublocality(?:_level_\d+)?|administrative_area_level_\d+)$/.test(t));
    if (!kind) continue;
    const values = [c.long_name,c.short_name].filter(v=>typeof v==='string' && v.trim());
    const group = kind==='country' ? {kind,aliases:countryAliases(values)} : areaGroup(values,kind,country);
    if (group.aliases.length) groups.push(group);
  }
  if (!groups.some(g=>g.kind!=='country')) groups.push(...fallback.filter(g=>g.kind!=='country'));
  if (!groups.some(g=>g.kind==='country')) groups.push(...fallback.filter(g=>g.kind==='country'));
  return {groups,components,fallback,countryCode:country,rawAddress:candidate.formatted_address,address:normalize(candidate.formatted_address),country:groups.find(g=>g.kind==='country')};
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
  // The added spelling can describe cuisine ("món Việt Nam"). Keep it for
  // explicit country/address matching, but never let it alone prove where a
  // caption's venue is. Other city or full-address evidence can still qualify.
  const aliases=profile.groups.flatMap(g=>g.kind==='country'
    ? g.aliases.filter(alias=>alias!=='viet nam') : g.aliases);
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
  const aliases = unique(profile.groups.flatMap(g=>g.aliases)).sort((a,b)=>b.length-a.length);
  let text = stripPostal(value,profile.countryCode,profile.components).split(/[,，;\n]/).map(part=>{
    let segment=normalize(stripPostal(part));
    let geographicSegment=segment;
    for (const alias of profile.country?.aliases || []) geographicSegment=removePhrase(geographicSegment,alias);
    geographicSegment=normalize(stripPostal(geographicSegment));
    // A locality alias is not a route alias: "HCMC Street" and "Saigon
    // Street" may be different roads. Preserve Latin route/house segments;
    // contiguous CJK administrative prefixes still need component stripping.
    const streetSegment=!CJK.test(segment) &&
      (STREET_MARKER.test(part) || (/\d/.test(segment) && /\p{L}/u.test(segment))) &&
      !matchesGeography(geographicSegment,profile.groups);
    if (streetSegment) return segment;
    // Country-first addresses may put country and postal-locality together.
    segment=geographicSegment;
    for (const alias of aliases) segment=removePhrase(segment,alias);
    return segment;
  }).join(' ');
  for (const c of profile.components) if (Array.isArray(c?.types) && c.types.includes('postal_code')) {
    for (const alias of unique([c.long_name,c.short_name].map(normalize))) text=removePhrase(text,alias);
  }
  return text.replace(/\b(?:no|number)\b/g,' ').replace(/\s+/g,' ').trim();
}
function vietnamStreetEvidence(hint,profile) {
  if (profile.countryCode!=='VN') return null;
  const values=kind=>unique(profile.components.filter(c=>Array.isArray(c?.types) && c.types.includes(kind))
    .flatMap(c=>[c.long_name,c.short_name]).filter(v=>typeof v==='string' && v.trim()));
  const numbers=unique(values('street_number').map(v=>v.trim().toLowerCase()));
  const routes=values('route');
  // Only compare complete Vietnamese routes with a single simple house
  // number. Keep the existing international street-comparison policy.
  if (numbers.length!==1 || !/^\d+[a-z]?$/.test(numbers[0]) || !routes.length || routes.some(v=>STREET_MARKER.test(v))) return null;
  const route=value=>normalize(value).replace(/^(?:pho|p|đuong|duong|đ|d)\s+/u,'');
  const normalizedRoutes=unique(routes.map(route));
  if (normalizedRoutes.length!==1) return null;
  const parse=value=>{
    const first=String(value || '').split(/[,，;\n]/)[0].trim();
    // Preserve compound number punctuation: 4B/1 and 4B-1 are not 4B.
    const match=first.match(/^(\d+\S*)\s+(.+)$/u);
    return match && {number:match[1].toLowerCase(),route:route(match[2])};
  };
  const wanted=parse(hint),actual=parse(profile.rawAddress);
  if (!wanted || !actual || actual.number!==numbers[0] || actual.route!==normalizedRoutes[0]) return null;
  // A mismatch provides no new evidence: route translations and unfamiliar
  // formats retain the existing comparison policy rather than a new veto.
  return {matches:wanted.number===numbers[0] && wanted.route===normalizedRoutes[0]};
}
function vietnamLowerAreaRecovery(regions,unmatched,profile,street) {
  if (!street?.matches || !unmatched.length) return false;
  // This incident's bare Đống Đa label is known to be below Hanoi. Do not
  // infer that any unfamiliar component before a city is a district: it
  // could be a different city. No equivalence to Google's newer ward is
  // asserted; the unresolved lower area must still require confirmation.
  const outer=profile.fallback.filter(g=>g.kind!=='country').at(-1);
  const city=profile.groups.find(g=>(g.kind==='locality' || (g.kind==='administrative_area_level_1' &&
    VIETNAM_LOCALITIES.some(names=>names.some(name=>g.aliases.includes(name))))) &&
    regions.at(-1)?.aliases.some(a=>g.aliases.includes(a)) && outer?.aliases.some(a=>g.aliases.includes(a)));
  if (!city) return false;
  const lowerArea=value=>/^(?:quan|phuong|district|ward) [\p{L}\p{N}][\p{L}\p{N}\s]*$|^[\p{L}\p{N}][\p{L}\p{N}\s]* (?:district|ward)$/u.test(value) ||
    (city.aliases.includes('ha noi') && /^(?:đong đa|dong da)$/u.test(value));
  return unmatched.every(g=>g!==regions.at(-1) && g.aliases.some(lowerArea)) &&
    profile.groups.some(g=>/^(?:sublocality(?:_level_\d+)?|administrative_area_level_[2345])$/.test(g.kind));
}
function addressUnits(value,profile) {
  const details={unit:[],floor:[]};
  // Remove only explicit labels, before normalizing punctuation. A bare 5,
  // a house suffix/range, or a CJK block number is not assumed to be a unit.
  const identifier='\\d+[a-z]?(?:[/-]\\d+[a-z]?)*';
  const labeled=new RegExp(`(?:^|\\s)(suite|ste|unit|shop|apt|apartment|room|floor|fl)\\.?\\s*#?\\s*(${identifier})$`,'i');
  const ordinal=/(?:^|\s)(\d+)(?:st|nd|rd|th)?\s+floor$/i;
  const routes=profile.components.filter(c=>Array.isArray(c?.types) && c.types.includes('route'))
    .flatMap(c=>[c.long_name,c.short_name]).map(normalize).filter(Boolean);
  const street=String(value || '').split(/[,，;\n]/).map(part=>{
    part=part.trim();
    const tagged=part.match(labeled),floor=tagged?null:part.match(ordinal);
    const found=tagged || floor;
    if (!found) return part;
    const prefix=part.slice(0,found.index).trim();
    // Do not eat a numbered route ("Unit 5 Road", or a typed "Unit 5").
    if (routes.some(route=>hasPhrase(normalize(part),route) && hasPhrase(route,normalize(found[0])))) return part;
    if (prefix && !(/\d/.test(prefix) && /\p{L}/u.test(prefix) &&
      (STREET_MARKER.test(prefix) || routes.some(route=>hasPhrase(normalize(prefix),route))))) return part;
    const kind=floor || /^(?:floor|fl)$/i.test(tagged[1])?'floor':'unit';
    details[kind].push((floor?floor[1]:tagged[2]).toLowerCase());
    return prefix;
  }).filter(Boolean).join(', ');
  // A unit-only fragment has no independent building address. Keep its
  // digits intact rather than inventing a street match from the city alone.
  if (!/\d/.test(streetText(street,profile))) return {street:String(value || ''),unit:[],floor:[]};
  return {street,unit:unique(details.unit).sort(),floor:unique(details.floor).sort()};
}
function addressEvidence(hint,profile) {
  if (!hint) return {matches:false,conflict:false,status:'not_provided',reasons:[],requiresSelection:false};
  const wantedUnits=addressUnits(hint,profile),actualUnits=addressUnits(profile.rawAddress,profile);
  const unitConflict=['unit','floor'].some(kind=>wantedUnits[kind].length && actualUnits[kind].length &&
    wantedUnits[kind].join('|')!==actualUnits[kind].join('|'));
  const unitUnknown=['unit','floor'].some(kind=>!!wantedUnits[kind].length!==!!actualUnits[kind].length);
  const unitRecovery=['unit','floor'].some(kind=>wantedUnits[kind].length || actualUnits[kind].length) &&
    normalize(hint)!==normalize(profile.rawAddress);
  const hintGroups = fallbackGeography(wantedUnits.street,undefined,profile.countryCode,profile.components);
  const countryHint=hintGroups.find(g=>g.kind==='country');
  const countryConflict=!!(countryHint && profile.country && !countryHint.aliases.some(a=>profile.country.aliases.includes(a)));
  const regions=hintGroups.filter(g=>g.kind!=='country');
  const unmatched=regions.filter(g=>!g.aliases.some(a=>matchesGeography(a,profile.groups)));
  const originals=profile.groups.map(g=>({...g,aliases:g.originalAliases || g.aliases}));
  const aliasRecovery=regions.some(g=>g.aliases.some(a=>matchesGeography(a,profile.groups)) &&
    !(g.originalAliases || g.aliases).some(a=>matchesGeography(a,originals)));
  const uncorroborated=unmatched.filter(g=>!g.aliases.some(a=>matchesGeography(a,profile.fallback)));
  const structuredStreet=vietnamStreetEvidence(hint,profile);
  const lowerAreaRecovery=vietnamLowerAreaRecovery(regions,unmatched,profile,structuredStreet);
  // In addresses anchored by a country or matching outer region, compare
  // geographic positions inward. A city mismatch before a matching state is a
  // contradiction. Additional missing inner wards have no comparable slot and
  // remain unknown; matches visible in the full address are corroboration.
  const actualRegions=profile.fallback.filter(g=>g.kind!=='country');
  const outerAgreement=regions.at(-1)?.aliases.some(a=>actualRegions.at(-1)?.aliases.includes(a));
  let regionConflict=false, actualIndex=actualRegions.length-1;
  let anchored=!!((countryHint && profile.country) || outerAgreement);
  // Align shared region names first instead of assuming equal component
  // counts. Omitting NY must not align West Village against New York City.
  for (let index=regions.length-1;index>=0;index--) {
    const group=regions[index];
    let anchor=-1;
    for (let i=actualIndex;i>=0;i--) {
      if (group.aliases.some(a=>actualRegions[i].aliases.includes(a))) {anchor=i;break;}
    }
    if (anchor>=0) {actualIndex=anchor-1;anchored=true;}
    else if (uncorroborated.includes(group) && anchored && actualIndex>=0 && !lowerAreaRecovery) regionConflict=true;
  }
  const wanted = streetText(wantedUnits.street,profile), actual = streetText(actualUnits.street,profile);
  const numbers = text => text.match(/\d+[a-z]?(?![a-z])/g) || [];
  const wantedNumbers = numbers(wanted), actualNumbers = numbers(actual);
  const numberConflict = wantedNumbers.length>0 && actualNumbers.length>0 &&
    wantedNumbers.join('|')!==actualNumbers.join('|');
  const compact = text => text.replace(/\s/g,'');
  const meaningful = /\p{L}/u.test(wanted) && wanted.length>=3;
  const conflict=countryConflict || regionConflict || numberConflict || unitConflict;
  const matches = !conflict && meaningful &&
    (lowerAreaRecovery || compact(wanted)===compact(actual) || hasPhrase(profile.address,normalize(hint)));
  const reasons=[];
  if (countryConflict) reasons.push('country_conflict');
  if (regionConflict) reasons.push('address_region_conflict');
  if (numberConflict) reasons.push('street_number_conflict');
  if (unitConflict) reasons.push('unit_conflict');
  if (unitUnknown) reasons.push('unit_unverified');
  if (unitRecovery) reasons.push('unit_format_recovered');
  if (unmatched.length) reasons.push('geography_components_missing');
  if (lowerAreaRecovery) reasons.push('lower_area_unverified');
  if (aliasRecovery) reasons.push('locality_alias');
  if (countryHint && !profile.country) reasons.push('country_unverified');
  if (!matches && !conflict) reasons.push('street_unverified');
  const unknown=unitUnknown || unmatched.length>0 || !!(countryHint && !profile.country) || !matches;
  return {matches:!!matches,conflict:!!conflict,status:conflict?'conflict':unknown?'unknown':'match',
    reasons,aliasRecovery,requiresSelection:!conflict && (unknown || aliasRecovery || unitRecovery)};
}

const GENERIC_NAME = new Set('the and of a an at in restaurant cafe coffee bar kitchen sushi ramen chicken house grill shop food bakery bistro dining blue red green golden new old best good great little big'.split(' '));
function nameEvidence(wanted,actual,profile,similarity) {
  const a=normalize(wanted), b=normalize(actual);
  if (!a || !b) return {score:0,partial:false};
  if (a===b) return {score:1,partial:false};
  if (profile.countryCode==='VN') {
    const withoutDescriptor=value=>value.replace(/^nha hang(?:\s+|$)/u,'');
    const left=withoutDescriptor(a),right=withoutDescriptor(b);
    if (left!==a || right!==b) {
      // Nhà hàng is a business descriptor, never shared identity evidence.
      // An exact remaining name can include short words (Tầm Vị), but this
      // descriptor recovery alone must never authorize an automatic save.
      if (!left || !right) return {score:0,partial:false};
      if (left===right) {
        const distinctive=left.split(' ').some(word=>word.length>=3 && !GENERIC_NAME.has(word) &&
          !profile.groups.some(g=>g.aliases.some(alias=>hasPhrase(alias,word))));
        return {score:distinctive?0.9:0,partial:distinctive};
      }
      return nameEvidence(left,right,profile,similarity);
    }
  }
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
