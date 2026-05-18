// Haversine great-circle distance between two lat/lng pairs. Returns
// kilometres. No external deps. Mirrored in mapd client src/utils/geo.ts —
// keep the two in sync if you ever tune the formula.

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function distanceKm(latA, lngA, latB, lngB) {
  const dLat = toRadians(latB - latA);
  const dLng = toRadians(lngB - lngA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(latA)) *
      Math.cos(toRadians(latB)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

module.exports = { distanceKm };
