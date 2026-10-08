const { normalizeCountry, countryFromAddress } = require('./countryNormalization');

// Shared policy with mapd/src/utils/cityNormalization.ts. This is a conservative
// legacy-data fallback, not a geocoder. Google locality components are preferred.
const CITY_COUNTRIES = new Set(['Singapore', 'Luxembourg', 'Monaco', 'Hong Kong', 'Macao', 'Djibouti', 'San Marino', 'Vatican City']);
const STATE_CODES = {
  'United States': new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')),
  Canada: new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' ')),
  Australia: new Set('ACT NSW NT QLD SA TAS VIC WA'.split(' ')),
};
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const isStateCode = (value, country) => STATE_CODES[country]?.has(value.toUpperCase()) || false;

function normalizeCity(raw, country) {
  // Check separators before collapsing whitespace, so full multiline addresses
  // cannot turn into plausible labels. Keep accents and non-Latin scripts.
  if (typeof raw !== 'string' || /[,，、;\n\r]/u.test(raw)) return null;
  const text = clean(raw);
  if (!text || text.length > 100 || !/\p{L}/u.test(text)) return null;
  const canonicalCountry = normalizeCountry(country);
  const countryLabel = normalizeCountry(text);
  if (countryLabel && !(CITY_COUNTRIES.has(countryLabel) && (!canonicalCountry || countryLabel === canonicalCountry))) return null;
  if (isStateCode(text, canonicalCountry)) return null;
  // Numbered municipalities are legitimate; arbitrary house/floor/postal
  // numbers are not. Structured Google components do not use this heuristic.
  const numberedLocality = /^(?:(?:district|distrito|quận|quan|arrondissement)\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+of\s+\p{L}+|\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))$/iu.test(text);
  if (/\p{N}/u.test(text) && !numberedLocality) return null;
  if (/[〒#@\/\\]/u.test(text)) return null;
  if (/(?:都|府|県|市)[\p{Script=Han}]+(?:区|區)[\p{Script=Han}]+/u.test(text)) return null;
  // Explicit building markers cannot be made into a municipality merely by
  // ending in 区/區. Keep this before the native municipality exception.
  if (/(?:ビル|建物|樓|楼|大廈|大厦|빌딩)/u.test(text)) return null;
  // Municipality suffixes disambiguate names such as 姫路市 (Himeji): 路
  // inside a city name is not itself evidence of a street.
  if (/^[\p{Script=Han}]{2,10}(?:市|区|區|縣|县|都|府|県)$/u.test(text)) return text;
  if (/\S+\s+(?:street|st\.?|avenue|ave\.?|boulevard|blvd\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|highway|hwy\.?|alley|sokak|caddesi)(?:\s+(?:[NSEW]{1,2}|north|south|east|west|northeast|northwest|southeast|southwest))?\s*$/iu.test(text)) return null;
  if (/^(?:rue|avenue|boulevard|chemin|route|allée|impasse|calle|carrer|carretera|rua|avenida|travessa|estrada|via|viale|piazza|jalan|jl\.?|lorong|soi|thanon|đường|duong|phố|pho|ngõ|ngo|hẻm|hem|ulica|ul\.)\s+/iu.test(text)) return null;
  if (/(?:straße|strasse|gasse|straat|laan|vägen|gatan)$/iu.test(text)) return null;
  if (/(?:丁目|番地|通り|ビル|建物|路|街|巷|弄|號|号|樓|楼|大廈|大厦|빌딩|도로|번길)/u.test(text)) return null;
  if (/\b(?:building|bldg|tower|floor|basement|suite|apartment|apt|unit|mall|shopping\s+cent(?:er|re))\b/iu.test(text)) return null;
  if (/^(?:unknown|n\/a|none|null|undefined|not available)$/i.test(text)) return null;
  return text;
}

function stripPostalCode(part, country) {
  // Country-specific postal forms only; never strip a generic leading house
  // number (which would turn "123 Main Street" into a locality).
  if (['Germany','France','Italy','Spain','Finland','Turkey','Türkiye'].includes(country)) return part.replace(/^\d{5}\s+/, '').replace(/\s+\d{5}$/, '');
  if (country === 'Japan') return part.replace(/^〒?\s*\d{3}-\d{4}\s*/, '').replace(/\s+\d{3}-\d{4}$/, '');
  if (country === 'Taiwan') return part.replace(/^\d{3}(?:\d{2,3})?\s*(?=\p{L})/u, '').replace(/\s+\d{3}(?:\d{2,3})?$/, '');
  if (country === 'Netherlands') return part.replace(/^\d{4}\s?[A-Z]{2}\s+/i, '').replace(/\s+\d{4}\s?[A-Z]{2}$/i, '');
  if (country === 'Poland') return part.replace(/^\d{2}-\d{3}\s+/, '').replace(/\s+\d{2}-\d{3}$/, '');
  if (['Sweden','Czechia','Slovakia'].includes(country)) return part.replace(/^\d{3}\s\d{2}\s+/, '').replace(/\s+\d{3}\s\d{2}$/, '');
  if (country === 'Portugal') return part.replace(/^\d{4}-\d{3}\s+/, '').replace(/\s+\d{4}-\d{3}$/, '');
  if (country === 'United Kingdom') return part.replace(/\s+(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i, '');
  if (country === 'Canada') return part.replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, '');
  if (country === 'Ireland') return part.replace(/\s+(?:[A-Z]\d{2}|D6W)\s?[A-Z\d]{4}$/i, '');
  return part;
}

function cityFromAddress(address, country) {
  const empty = { city: null, region: null };
  if (typeof address !== 'string' || !address.trim()) return empty;
  const printedCountry = countryFromAddress(address);
  const canonicalCountry = normalizeCountry(country) || printedCountry;
  if (!canonicalCountry || (printedCountry && printedCountry !== canonicalCountry)) return empty;
  const parts = address.split(/[,，、;\n]/u).map(clean).filter(Boolean);
  // A single untyped segment could be a venue/street. It is not city evidence.
  if (parts.length < 2) return empty;
  const firstCountry = normalizeCountry(parts[0]);
  const lastCountry = normalizeCountry(parts[parts.length - 1]);
  if (firstCountry && lastCountry && firstCountry !== 'Georgia' && lastCountry !== 'Georgia' && firstCountry !== lastCountry) return empty;
  const last = parts.length - 1;
  const countryAtEnd = normalizeCountry(parts[last]) === canonicalCountry;
  const countryAtStart = normalizeCountry(parts[0]) === canonicalCountry;
  const countryIndex = countryAtEnd ? last : countryAtStart ? 0 : -1;
  let region = null;
  const candidates = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === countryIndex) continue;
    // Do not reinterpret a repeated boundary country as city except city-states.
    let part = parts[i];
    const statePostal = part.match(/^(?:(.+?)\s+)?([A-Z]{2,3})(?:\s+(?:\d{4,5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d))?$/i);
    if (statePostal && isStateCode(statePostal[2], canonicalCountry)) {
      region = statePostal[2].toUpperCase();
      if (!statePostal[1]) continue;
      part = statePostal[1];
    }
    // Postal-city combinations are only considered beside the country/region,
    // not at the street end of an ordinary country-last address.
    if (i > 0 || countryIndex === 0) part = stripPostalCode(part, canonicalCountry);
    // East Asian native addresses can concatenate city, district and street.
    // Recover only an explicitly delimited municipality at the segment start.
    if (['Taiwan','China','Japan'].includes(canonicalCountry) && !normalizeCity(part, canonicalCountry)) {
      const local = canonicalCountry === 'Japan' ? part.replace(/^[\p{Script=Han}]{2,3}[府県]/u, '') : part;
      const boundaries = [...local.matchAll(/[市縣县]/gu)]
        .map(match => local.slice(0, (match.index || 0) + 1))
        .filter(value => /^[\p{Script=Han}]{2,10}[市縣县]$/u.test(value));
      // 市 can occur within city or street names: 市川市市川 / 臺北市市場街.
      // Multiple possible boundaries are ambiguous, not a greedy substring.
      if (boundaries.length > 1) continue;
      part = boundaries[0] || (canonicalCountry === 'Japan' ? local.match(/^(東京都)/u)?.[1] : null) || part;
    }
    const city = normalizeCity(part, canonicalCountry);
    if (city) candidates.push(city);
  }
  const unique = [...new Set(candidates)];
  // Prefer explicit municipality labels over districts/neighborhoods where the
  // printed language gives us a hierarchy. Never infer by street-name position.
  const municipalities = unique.filter(value => /(?:市|特別市|특별시|광역시)$/u.test(value) || /\sCity$/i.test(value));
  if (municipalities.length === 1) return { city: municipalities[0], region };
  if (unique.length === 1) return { city: unique[0], region };
  // Several untyped labels could be city, province, venue or neighborhood. Leave
  // city unknown instead of making a new bogus option; the pin stays in All.
  return { city: null, region };
}

function resolvePinCity(city, address, country) {
  const canonicalCountry = normalizeCountry(country) || countryFromAddress(address);
  return normalizeCity(city, canonicalCountry) || cityFromAddress(address, canonicalCountry).city;
}

module.exports = { normalizeCity, cityFromAddress, resolvePinCity };
