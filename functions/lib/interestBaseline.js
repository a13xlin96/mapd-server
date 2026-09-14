// A bounded inventory snapshot for recommendation cold start, not a historical
// count of saves. Never add these counts to post-cutover verified save events.
function summarizeInterestBaseline(pins, cutoverMs, { limit = 64 } = {}) {
  if (!Number.isFinite(cutoverMs) || !Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('invalid_baseline_options');
  const maps = { categories: new Map(), cities: new Map(), countries: new Map() };
  let currentOwnedPinsBeforeCutover = 0, unknownCreationTime = 0;
  for (const snapshot of pins) {
    const created = typeof snapshot.createTime?.toMillis === 'function' ? snapshot.createTime.toMillis() : NaN;
    if (!Number.isFinite(created)) { unknownCreationTime++; continue; }
    if (created >= cutoverMs) continue;
    currentOwnedPinsBeforeCutover++;
    const pin = snapshot.data();
    for (const [field, key] of [['categories', 'category'], ['cities', 'city'], ['countries', 'country']]) {
      const value = typeof pin[key] === 'string' && pin[key].trim() ? pin[key].trim().normalize('NFC').slice(0, 128) : 'unknown';
      maps[field].set(value, (maps[field].get(value) || 0) + 1);
    }
  }
  const summaries = Object.fromEntries(Object.entries(maps).map(([field, map]) => {
    const entries = [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return [field, { values: entries.slice(0, limit).map(([value, count]) => ({ value, count })),
      otherCount: entries.slice(limit).reduce((n, entry) => n + entry[1], 0) }];
  }));
  return { schemaVersion: 2, provenance: 'current_owned_inventory_before_cutover',
    metadataProvenance: 'saved_pin', historyReconstructed: false,
    currentOwnedPinsBeforeCutover, unknownCreationTime, ...summaries };
}
module.exports = { summarizeInterestBaseline };
