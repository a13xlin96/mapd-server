const { normalizeCountry, normalizeCountryCode, countryFromAddress } = require('./countryNormalization');
const { decodeHtmlEntities, cleanSocialText } = require('./utils');

const LOCATION_PATTERNS = [
  /\b(sunnyside|astoria|williamsburg|bushwick|greenpoint|ridgewood|flushing|jackson heights|elmhurst|chinatown|soho|tribeca|lower east side|upper west side|east village|west village|brooklyn|queens|bronx|manhattan|harlem|midtown)\b/gi,
  /\b(\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct)\.?)\b/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/g,
];

function extractLocationContext(text) {
  const locations = [];
  for (const pattern of LOCATION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) locations.push(...matches.map((m) => m.trim()));
  }
  return locations;
}

function extractPlaceSignals(text) {
  const signals = [];

  const quoted = text.match(/["']([^"']{3,50})["']/g);
  if (quoted) {
    signals.push(...quoted.map((q) => ({ name: q.replace(/["']/g, '').trim(), priority: 2 })));
  }

  const atIn = text.match(/(?:at|in|@)\s+([A-Z][A-Za-z\s'&]{2,40})/g);
  if (atIn) {
    signals.push(...atIn.map((m) => ({ name: m.replace(/^(?:at|in|@)\s+/i, '').trim(), priority: 3 })));
  }

  const properNouns = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  if (properNouns) {
    signals.push(
      ...properNouns
        .filter((p) => p.length > 4 && p.length < 50)
        .map((p) => ({ name: p, priority: 4 }))
    );
  }

  return signals;
}

function extractPinMarker(rawText) {
  const pinMatch = rawText.match(/📍\s*([^\n]{2,120})/);
  if (!pinMatch) return null;

  let name = pinMatch[1]
    .replace(/#\w+/g, '')
    .replace(/@\w+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();

  const addressCutoffs = [
    /\bNo\.\s*\d/i,
    /\b\d+\s+\w+\s+(St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct|Sec|Lane|Alley)\b/i,
    /\(\s*(Original|Main|Branch|Location)\b/i,
    /,\s*\d/,
  ];

  for (const pattern of addressCutoffs) {
    const cutoffMatch = name.match(pattern);
    if (cutoffMatch && cutoffMatch.index && cutoffMatch.index > 3) {
      name = name.slice(0, cutoffMatch.index).replace(/[,\s]+$/, '');
      break;
    }
  }

  return name.length >= 2 ? name : null;
}

function extractLocationQuery(title, description) {
  const rawTitle = decodeHtmlEntities(title);
  const rawDesc = decodeHtmlEntities(description);
  const cleanTitle = cleanSocialText(rawTitle);
  const cleanDesc = cleanSocialText(rawDesc);
  const combined = `${cleanTitle} ${cleanDesc}`;

  const pinMarker = extractPinMarker(rawDesc) || extractPinMarker(rawTitle);

  const signals = [
    ...extractPlaceSignals(cleanTitle),
    ...extractPlaceSignals(cleanDesc),
  ];

  const locations = extractLocationContext(combined);

  let query = '';
  if (pinMarker) {
    query = pinMarker;
  } else if (signals.length > 0) {
    const best = signals.sort((a, b) => a.priority - b.priority || b.name.length - a.name.length)[0];
    query = best.name;
  }

  if (query) {
    if (locations.length > 0 && !query.toLowerCase().includes(locations[0].toLowerCase())) {
      query = `${query} ${locations[0]}`;
    }
  } else if (locations.length > 0) {
    query = locations.join(' ');
  } else {
    const words = combined.split(' ').filter((w) => w.length > 2);
    query = words.slice(0, 7).join(' ');
  }

  return query.slice(0, 80);
}

function extractLocationFromComponents(components) {
  // Component order is not a hierarchy: prefer a real locality to a county.
  const name = type => components.find(c => c?.types?.includes(type) && typeof c.long_name === 'string' && c.long_name.trim())?.long_name.trim() || null;
  const country = normalizeCountry(name('country')) || components
    .filter(c => c?.types?.includes('country'))
    .map(c => normalizeCountryCode(c.short_name)).find(Boolean) || null;
  let region = name('administrative_area_level_1');
  let city = name('locality') || name('postal_town') || name('administrative_area_level_2');
  if (!city && region) {
    city = region;
    region = null;
  }
  if (!city) city = name('sublocality_level_1') || name('sublocality');

  return { country, region, city };
}

function extractLocation(formattedAddress) {
  if (!formattedAddress) return { country: null, region: null, city: null };

  const parts = formattedAddress.split(/[,，、;\n]/).map((p) => p.trim()).filter(Boolean);
  const country = countryFromAddress(formattedAddress);

  let city = null;
  let region = null;

  // Skip only the country boundary, not a same-named city (Singapore,
  // Luxembourg). Prefer the last boundary when both carry the country name.
  const countryIndex = country && normalizeCountry(parts[parts.length - 1]) !== country ? 0 : parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    if (i === countryIndex) continue;
    const part = parts[i];
    if (/^\d+/.test(part)) continue;
    if (/^\d{4,}$/.test(part.replace(/\s/g, ''))) continue;
    if (/^[A-Z]{2}\s+\d{4,}/.test(part)) {
      region = part.replace(/\s+\d+.*$/, '');
      continue;
    }
    // Printed addresses have no universal order. Numbered streets, floors
    // and postal-address fragments are not reliable city names. This does
    // not affect structured localities such as District 1.
    if (/\p{N}/u.test(part)) continue;
    if (!city) city = part;
    else if (!region) region = part;
  }

  return { country, region, city };
}

// Search already includes address components. Rich details are optional and
// deferred; never throw away Search geography when that cache is cold/partial.
function extractPlaceLocation(details, searchResult) {
  const components = [details, searchResult].flatMap(place =>
    Array.isArray(place?.address_components) ? place.address_components : []);
  const location = extractLocationFromComponents(components);
  if (location.country && location.city) return location;
  const fallbacks = [details, searchResult].map(place => extractLocation(place?.formatted_address || ''));
  const country = location.country || fallbacks.find(value => value.country)?.country || null;
  // A partial Details address must not hide complete Search geography. Do
  // not supplement a known country using an explicitly different country.
  const compatible = fallbacks.filter(value => !value.country || value.country === country);
  const cityFallback = compatible.find(value => value.city);
  return {
    country,
    city: location.city || cityFallback?.city || null,
    // Structured cities can be promoted admin areas with intentional null region.
    region: location.city ? location.region : (location.region || cityFallback?.region || compatible.find(value => value.region)?.region || null),
  };
}

module.exports = {
  extractPinMarker,
  extractLocationQuery,
  extractLocationFromComponents,
  extractPlaceLocation,
  extractLocation,
};
