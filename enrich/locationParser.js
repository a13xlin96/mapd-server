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
  let country = null;
  let region = null;
  let city = null;
  let district = null;

  for (const c of components) {
    const types = c.types;
    if (types.includes('country')) {
      country = c.long_name;
    } else if (types.includes('administrative_area_level_1')) {
      region = c.long_name;
    } else if (
      types.includes('locality')
      || types.includes('postal_town')
      || types.includes('administrative_area_level_2')
    ) {
      if (!city) city = c.long_name;
    } else if (types.includes('sublocality_level_1') || types.includes('sublocality')) {
      if (!district) district = c.long_name;
    }
  }

  if (!city && region) {
    city = region;
    region = null;
  }

  if (!city && district) city = district;

  return { country, region, city };
}

function extractLocation(formattedAddress) {
  if (!formattedAddress) return { country: null, region: null, city: null };

  const parts = formattedAddress.split(',').map((p) => p.trim());
  const country = parts.length >= 2 ? parts[parts.length - 1] : null;

  let city = null;
  let region = null;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (/^\d+/.test(part)) continue;
    if (/^\d{4,}$/.test(part.replace(/\s/g, ''))) continue;
    if (/^[A-Z]{2}\s+\d{4,}/.test(part)) {
      region = part.replace(/\s+\d+.*$/, '');
      continue;
    }
    if (!city) city = part;
    else if (!region) region = part;
  }

  return { country, region, city };
}

module.exports = {
  extractPinMarker,
  extractLocationQuery,
  extractLocationFromComponents,
  extractLocation,
};
