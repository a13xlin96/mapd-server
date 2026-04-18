const CATEGORY_MAP = [
  {
    types: ['restaurant', 'food', 'cafe', 'bakery', 'bar', 'meal_takeaway', 'meal_delivery'],
    category: 'food',
  },
  {
    types: ['lodging', 'campground', 'motel', 'resort'],
    category: 'accommodation',
  },
  {
    types: ['tourist_attraction', 'museum', 'art_gallery', 'amusement_park', 'zoo', 'aquarium', 'stadium'],
    category: 'attraction',
  },
  {
    types: ['park', 'natural_feature', 'hiking_area'],
    category: 'nature',
  },
  {
    types: ['shopping_mall', 'store', 'clothing_store', 'book_store', 'supermarket'],
    category: 'shopping',
  },
  {
    types: ['spa', 'gym', 'beauty_salon', 'hair_care'],
    category: 'wellness',
  },
  {
    types: ['night_club', 'movie_theater', 'bowling_alley', 'casino', 'concert_hall'],
    category: 'entertainment',
  },
];

function mapToCategory(types) {
  for (const mapping of CATEGORY_MAP) {
    if (types.some((t) => mapping.types.includes(t))) return mapping.category;
  }
  return 'other';
}

module.exports = { mapToCategory };
