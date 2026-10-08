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
for (const name of Object.values(COUNTRY_ALIASES)) COUNTRY_ALIASES[name.toLowerCase()] = name;

function normalizeCountry(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip trailing postal-code tokens. The formatted_address fallback in
  // locationParser can include postal codes in the country slot — e.g.
  // "Taiwan 106", "Japan 〒100", "United Kingdom E1 6AN", "USA 90210".
  // A token counts as a postal code if it has at least one digit and no
  // lowercase letters; that keeps real country names with digits (none
  // exist today) and letters (Côte d'Ivoire, São Tomé, etc.) intact.
  // Some legacy values have no space before the postal suffix.
  const tokens = trimmed.replace(/(\p{L})(〒?\d[\d-]*)$/u, '$1 $2').split(/\s+/);
  while (
    tokens.length > 1 &&
    /\d/.test(tokens[tokens.length - 1]) &&
    !/[a-z]/.test(tokens[tokens.length - 1])
  ) {
    tokens.pop();
  }
  const stripped = tokens.join(' ').trim() || trimmed;
  return COUNTRY_ALIASES[stripped.toLowerCase()] ?? stripped;
}

module.exports = { normalizeCountry };
