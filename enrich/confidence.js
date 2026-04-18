const { cleanSocialText } = require('./utils');

const KNOWN_TRAVEL_SITES = ['tripadvisor', 'yelp', 'google', 'opentable', 'michelin', 'timeout'];

function calculateConfidence(results, ogData) {
  if (results.length === 0) return { place: null, score: 0 };

  const top = results[0];
  let score = 0;

  const cleanedTitle = cleanSocialText(ogData.title || '').toLowerCase();
  const cleanedDesc = cleanSocialText(ogData.description || '').toLowerCase();

  if (top.name && cleanedTitle.includes(top.name.toLowerCase())) score += 40;

  const combined = `${cleanedTitle} ${cleanedDesc}`;
  const addressWords = (top.formatted_address || '').toLowerCase().split(/[,\s]+/).filter((w) => w.length > 3);
  if (addressWords.some((word) => combined.includes(word))) score += 20;

  if (KNOWN_TRAVEL_SITES.some((site) => (ogData.siteName || '').toLowerCase().includes(site))) score += 20;

  if (top.user_ratings_total && top.user_ratings_total > 100) score += 10;

  if (results.length === 1) score += 10;

  return {
    place: {
      place_id: top.place_id,
      name: top.name,
      formatted_address: top.formatted_address,
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
      types: top.types || [],
      rating: top.rating,
      user_ratings_total: top.user_ratings_total,
    },
    score,
  };
}

module.exports = { calculateConfidence };
