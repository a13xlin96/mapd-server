const countryNames = require('./countryNames.json');

// Pinned region names from Node/CLDR (English, Chinese, Japanese, Korean).
// Includes territories used by Google. No device Intl support or API call is
// required; keep this data/helper in sync with mapd/src/utils.
const COUNTRY_ALIASES = {
  'usa': 'United States',
  'u.s.a.': 'United States',
  'u.s.': 'United States',
  'us': 'United States',
  'united states of america': 'United States',
  'america': 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'u.a.e.': 'United Arab Emirates',
  'tw': 'Taiwan',
  '台灣': 'Taiwan',
  '臺灣': 'Taiwan',
  'jp': 'Japan',
  '日本': 'Japan',
  'vn': 'Vietnam',
  'viet nam': 'Vietnam',
  'việt nam': 'Vietnam',
  'hk': 'Hong Kong',
  '香港': 'Hong Kong',
};

const countryByCode = new Map();
const countryByName = new Map();
const addressCountryByName = new Map();
const key = (name) => name.normalize('NFKC').replace(/[’‘]/g, "'").replace(/&/g, 'and').replace(/\bst\. /gi, 'Saint ').trim().toLowerCase();
for (const [code, names] of Object.entries(countryNames)) {
  countryByCode.set(code, names[0]);
  // Legacy country fields can contain state codes (CA, IN). Codes are only
  // trusted when they came from a structured Google country component.
  for (const name of names) countryByName.set(key(name), names[0]);
  for (const name of names) addressCountryByName.set(key(name), names[0]);
}
for (const [alias, name] of Object.entries(COUNTRY_ALIASES)) {
  countryByName.set(key(alias), name);
  if (!/^[a-z]{2}$/i.test(alias) || ['us', 'uk', 'jp', 'tw', 'vn', 'hk'].includes(alias)) addressCountryByName.set(key(alias), name);
}

/** Normalize an actual country field, never accept a street/building as a country. */
function normalizeCountryValue(raw, names) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.normalize('NFKC').trim();
  const direct = names.get(key(text));
  if (direct) return direct;
  // Postal suffixes must be plausible codes, not floors such as 1F/B1F.
  // Use the address-name map here: "CA 90210" is not evidence for Canada.
  const tokens = text.replace(/(\p{L})(〒?\d[\d-]*)$/u, '$1 $2').split(/\s+/);
  for (let split = tokens.length - 1; split > 0; split--) {
    const country = addressCountryByName.get(key(tokens.slice(0, split).join(' ')));
    if (!country) continue;
    const suffix = tokens.slice(split).join(' ');
    if (/^(?:〒\s*)?\d{3,10}(?:-\d{3,4})?$/.test(suffix)
      || (country === 'Poland' && /^\d{2}-\d{3}$/.test(suffix))
      || (['Sweden', 'Slovakia', 'Czechia'].includes(country) && /^\d{3} \d{2}$/.test(suffix))
      || (country === 'United Kingdom' && /^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(suffix))
      || (country === 'Canada' && /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(suffix))
      || (country === 'Netherlands' && /^\d{4}\s?[A-Z]{2}$/i.test(suffix))
      || (country === 'Ireland' && /^[A-Z\d]{3}\s?[A-Z\d]{4}$/i.test(suffix))) return country;
  }
  return null;
}

function normalizeCountry(raw) {
  return normalizeCountryValue(raw, countryByName);
}

/** Only for the short_name of a structured country address component. */
function normalizeCountryCode(raw) {
  return typeof raw === 'string' ? countryByCode.get(raw.normalize('NFKC').trim().toUpperCase()) || null : null;
}

/** Recover only an explicit country at an address boundary, in either order. */
function countryFromAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return null;
  const parts = address.split(/[,，、;\n]/).map(part => part.trim()).filter(Boolean);
  // A street named Japan/Georgia and state codes such as CA/IN are ambiguous.
  // Do not scan interior street/building text or infer a country from script.
  const edgeCountry = (part) => {
    if (!part) return null;
    const country = normalizeCountryValue(part, addressCountryByName);
    return country === 'Georgia' ? null : country;
  };
  const first = edgeCountry(parts[0]);
  const last = edgeCountry(parts[parts.length - 1]);
  if (first && last && first !== last) return null;
  return last || first;
}

/** Read-only repair for pins saved by the legacy formatted-address parser. */
function resolvePinCountry(country, address) {
  return normalizeCountry(country) || countryFromAddress(address);
}

module.exports = { normalizeCountry, normalizeCountryCode, countryFromAddress, resolvePinCountry };
