const { hash } = require('./contentIdentity');

const SCHEMA = 1;
const clean = (value, max = 128) => typeof value === 'string' && value.trim()
  ? value.trim().normalize('NFC').slice(0, max) : null;
const dataOf = snapshot => snapshot?.exists ? snapshot.data() : null;
const count = (value, delta) => Math.max(0, (Number.isFinite(value) ? value : 0) + delta);
const millis = value => typeof value?.toMillis === 'function' ? value.toMillis() : null;
const BUSINESS_FIELDS = [
  'types', 'primaryType', 'cuisine', 'rating', 'userRatingsTotal', 'priceLevel', 'priceRange',
  'dineIn', 'takeout', 'delivery', 'reservable', 'businessStatus', 'editorialSummary',
  'servesBreakfast', 'servesLunch', 'servesDinner', 'servesBrunch', 'servesBeer', 'servesWine',
  'servesCocktails', 'servesCoffee', 'servesDessert', 'servesVegetarianFood', 'outdoorSeating',
  'goodForChildren', 'goodForGroups', 'allowsDogs', 'restroom', 'menuForChildren', 'liveMusic',
  'paymentOptions', 'parkingOptions', 'accessibilityOptions', 'openingPeriods',
  'weekdayDescriptions', 'currentOpeningPeriods', 'currentWeekdayDescriptions', 'utcOffsetMinutes',
];

// Selected business attributes only; bound nested provider data and never copy
// source links, notes, list membership, visits or arbitrary pin fields.
function bounded(value, depth = 0) {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return clean(value, 1024);
  if (!value || typeof value !== 'object' || depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => bounded(item, depth + 1));
  return Object.fromEntries(Object.keys(value).sort().slice(0, 24)
    .filter(key => !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(key => [key, bounded(value[key], depth + 1)]));
}

// IDs are namespaced within the already owner-read-only interestProfile
// collection. No rules change or public/collaborator-visible pin data needed.
function metadataRefsFor(db, uid, pinId, generation) {
  const collection = db.collection(`users/${uid}/interestProfile`);
  return {
    summary: collection.doc('currentMetadata'),
    head: collection.doc(`metadataHead_${hash(pinId)}`),
    contribution: generation ? collection.doc(`metadataPin_${hash(JSON.stringify([pinId, generation]))}`) : null,
    bucket: id => collection.doc(`metadataFeature_${id}`),
    trip: id => collection.doc(`metadataTrip_${id}`),
  };
}

function currentMetadata(pin) {
  // Category/geography are effective saved values, including user corrections.
  // Never reclassify them from Google types or use tripSignalIdAtSave as a
  // current destination. That attribution and tripSaveStats remain history.
  const geography = Object.fromEntries(['city', 'region', 'country'].map(key => [key, clean(pin[key])]));
  for (const [key, limit] of [['latitude', 90], ['longitude', 180]]) {
    geography[key] = Number.isFinite(pin[key]) && Math.abs(pin[key]) <= limit ? pin[key] : null;
  }
  const tripId = geography.city && geography.country
    ? hash(JSON.stringify([geography.city.toLowerCase(), geography.country.toLowerCase()])) : null;
  const detailsState = pin.detailsState == null && pin.detailsSchemaVersion == null ? 'legacy'
    : ['pending', 'complete', 'needs_action'].includes(pin.detailsState) ? pin.detailsState : 'unknown';
  const known = detailsState === 'complete' || detailsState === 'legacy';
  return {
    category: clean(pin.category, 64), geography, currentTripId: tripId,
    placeId: clean(pin.placeId, 200),
    detailsSchemaVersion: Number.isSafeInteger(pin.detailsSchemaVersion) ? pin.detailsSchemaVersion : null,
    detailsState, detailsRevision: Number.isSafeInteger(pin.detailsRevision) && pin.detailsRevision >= 0 ? pin.detailsRevision : null,
    detailsUpdatedAtMs: millis(pin.detailsUpdatedAt),
    businessAttributes: known ? Object.fromEntries(BUSINESS_FIELDS.map(key => [key, bounded(pin[key])])) : null,
    metadataProvenance: 'current_saved_pin',
    businessProvenance: known ? (detailsState === 'legacy' ? 'legacy_saved_pin' : 'completed_saved_pin_details') : 'unknown',
    tripProvenance: tripId ? 'current_saved_pin_geography' : 'unknown',
  };
}

function buckets(item) {
  if (!item?.exists) return [];
  return [['category', item.category], ['city', item.geography.city], ['country', item.geography.country]]
    .filter(([, value]) => value !== null)
    .map(([dimension, value]) => ({ id: hash(JSON.stringify([dimension, value])), dimension, value }));
}

/** Prepare inside the accounting transaction AFTER account/control checks.
 * Reads all affected documents and returns a synchronous write phase. Current
 * DB snapshots (not event payloads or client generation fields) supply pin,
 * generation and accountGeneration. One active contribution per pin; retired
 * generations remain separate records with exists:false.
 */
function createPinMetadataAccounting({ db, admin }) {
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();

  async function prepare({ txn, uid, pinId, pin, generation, accountGeneration, priorContribution, profile }) {
    const refs = metadataRefsFor(db, uid, pinId, generation);
    // Older deployed accounting functions replace pinContributions wholesale.
    // Keep this projection's pointer in a document only this writer owns.
    const head = dataOf(await txn.get(refs.head));
    const previousGeneration = head?.accountGeneration === accountGeneration ? head.generation
      : priorContribution?.metadataGeneration || priorContribution?.generation;
    const previousRef = previousGeneration ? metadataRefsFor(db, uid, pinId, previousGeneration).contribution : null;
    const previous = previousRef ? dataOf(await txn.get(previousRef)) : null;
    if (previous && (previous.userId !== uid || previous.pinId !== pinId || previous.generation !== previousGeneration)) {
      throw new Error('invalid_metadata_contribution_owner');
    }
    const prior = previous?.exists && previous.accountGeneration === accountGeneration ? previous : null;
    const sameGeneration = previousGeneration === generation && previous?.accountGeneration === accountGeneration;
    const next = pin ? { schemaVersion: SCHEMA, kind: 'pin_metadata', userId: uid, pinId, generation, accountGeneration, exists: true,
      ...currentMetadata(pin),
      tripSignalIdAtSave: sameGeneration ? previous.tripSignalIdAtSave : clean(pin.tripSignalIdAtSave, 200),
    } : null;
    if (next) next.digest = hash(JSON.stringify(next));
    const changed = !!prior !== !!next || (next !== null && prior?.digest !== next.digest);
    const profilePatch = next && profile.lastPinId === pinId && profile.lastPinGeneration === generation
      && (profile.lastPinCategory !== next.category || profile.lastPinCity !== next.geography.city
        || profile.lastPinCountry !== next.geography.country)
      ? { lastPinCategory: next.category, lastPinCity: next.geography.city, lastPinCountry: next.geography.country } : {};
    const headData = {schemaVersion:SCHEMA,kind:'pin_metadata_head',userId:uid,pinId,
      accountGeneration,generation:next ? generation : null};
    if (!changed) return { changed: false, profilePatch, apply() {
      if (!head || head.accountGeneration !== accountGeneration || head.generation !== headData.generation) txn.set(refs.head,headData);
    } };

    const summaryData = dataOf(await txn.get(refs.summary));
    const summary = summaryData?.accountGeneration === accountGeneration ? summaryData : {};
    const deltas = new Map(), tripDeltas = new Map();
    for (const [item, delta] of [[prior, -1], [next, 1]]) {
      for (const bucket of buckets(item)) {
        const entry = deltas.get(bucket.id) || { ...bucket, delta: 0 };
        entry.delta += delta; deltas.set(bucket.id, entry);
      }
      if (item?.currentTripId) {
        const id = item.currentTripId;
        const entry = tripDeltas.get(id) || { id, city: item.geography.city, country: item.geography.country, delta: 0 };
        entry.delta += delta; tripDeltas.set(id, entry);
      }
    }
    const writes = [];
    for (const [entries, refFor] of [[deltas, refs.bucket], [tripDeltas, refs.trip]]) {
      for (const { id, delta, ...identity } of entries.values()) {
        if (!delta) continue;
        const ref = refFor(id), data = dataOf(await txn.get(ref));
        const current = data?.accountGeneration === accountGeneration ? data : {};
        writes.push({ ref, data: { schemaVersion: SCHEMA, kind: entries === deltas ? 'metadata_feature' : 'trip_metadata',
          userId: uid, accountGeneration, ...identity,
          currentPins: count(current.currentPins, delta), provenance: 'current_pin_metadata', updatedAt: stamp() } });
      }
    }
    return {
      changed, profilePatch,
      apply() {
        txn.set(refs.head,headData);
        for (const { ref, data } of writes) txn.set(ref, data);
        if (previous?.exists && (!next || !sameGeneration)) {
          txn.set(previousRef, { ...previous, exists: false, updatedAt: stamp() });
        }
        if (next) txn.set(refs.contribution, { ...next, updatedAt: stamp() });
        txn.set(refs.summary, { schemaVersion: SCHEMA, kind: 'current_metadata', userId: uid, accountGeneration,
          currentPins: count(summary.currentPins, Number(!!next) - Number(!!prior)),
          knownDetailsPins: count(summary.knownDetailsPins, Number(!!next?.businessAttributes) - Number(!!prior?.businessAttributes)),
          revision: count(summary.revision, 1), provenance: 'current_pin_metadata', updatedAt: stamp() });
      },
    };
  }
  return { prepare, refsFor: (uid, pinId, generation) => metadataRefsFor(db, uid, pinId, generation) };
}

module.exports = { createPinMetadataAccounting, metadataRefsFor, currentMetadata, BUSINESS_FIELDS, SCHEMA };
