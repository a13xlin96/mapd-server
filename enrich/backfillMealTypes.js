// One-time backfill that re-enriches existing pins from Google Places to
// capture meal-type booleans (servesBreakfast/Lunch/Dinner/Brunch) and the
// full priceRange Money shape — fields that were not persisted in the
// original pin pipeline.
//
// Paginated, idempotent, safe to re-run:
//   - skips pins already stamped with PLACE_ENRICHMENT_VERSION
//   - uses startAfterDocId to resume after a previous run
//   - dryRun=true returns the scan plan without writing anything
//   - reuses the schema-versioned place-details cache where possible
//
// The backfill scope is fixed — there is no per-field opt-out. Splitting
// the version across partial-field runs creates a footgun where a pin can
// be stamped "complete" without ever receiving one of the scoped fields,
// permanently locking it out of future passes. If the scope changes, bump
// PLACE_ENRICHMENT_VERSION and re-run.

const { getPlaceDetails } = require('./places');

const DEFAULT_BATCH_SIZE = 50;

// Bumped whenever the scope or persisted shape of a backfilled field
// changes. Pins stamped with the current version are skipped — so a
// legitimate `null` from "Google said unknown" doesn't relitigate, and
// a real schema change (new field, changed shape) cleanly retriggers
// every pin via this constant.
//   v3: priceRange now persists startNanos/endNanos alongside units
//   v2: initial backfill (serves* + priceRange.units/currencyCode — lossy, deprecated)
const PLACE_ENRICHMENT_VERSION = 3;

function mapMoney(money) {
  if (!money) return null;
  return {
    units: money.units != null ? Number(money.units) : null,
    nanos: money.nanos != null ? Number(money.nanos) : null,
    currencyCode: money.currency_code || null,
  };
}

function buildPriceRange(priceRange) {
  if (!priceRange) return null;
  const startPrice = mapMoney(priceRange.start_price);
  const endPrice = mapMoney(priceRange.end_price);
  const currencyCode =
    (startPrice && startPrice.currencyCode) ||
    (endPrice && endPrice.currencyCode) ||
    null;
  return {
    startUnits: startPrice ? startPrice.units : null,
    startNanos: startPrice ? startPrice.nanos : null,
    endUnits: endPrice ? endPrice.units : null,
    endNanos: endPrice ? endPrice.nanos : null,
    currencyCode,
  };
}

async function runBackfillMealTypes({
  firestore,
  admin,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
  categoryFilter = 'food',
} = {}) {
  if (!firestore) throw new Error('firestore admin not configured');

  let query = firestore.collection('pins').where('category', '==', categoryFilter).orderBy('__name__').limit(batchSize);
  if (startAfterDocId) {
    query = query.startAfter(startAfterDocId);
  }

  const snap = await query.get();

  const stats = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    lastDocId: null,
    dryRun,
  };

  for (const doc of snap.docs) {
    stats.scanned += 1;
    stats.lastDocId = doc.id;
    const pin = doc.data();

    if (!pin.placeId) {
      stats.skipped += 1;
      continue;
    }

    // Skip on the version marker, not on field presence. Field-presence
    // skipping treats `null` from a stale cached Place Details payload as
    // a completed backfill and prevents the pin from ever being retried.
    if (pin.placeEnrichmentVersion === PLACE_ENRICHMENT_VERSION) {
      stats.skipped += 1;
      continue;
    }

    let details;
    try {
      details = await getPlaceDetails(pin.placeId);
    } catch (err) {
      stats.failed += 1;
      stats.failures.push({ id: doc.id, placeId: pin.placeId, error: err.message });
      continue;
    }

    if (!details) {
      stats.failed += 1;
      stats.failures.push({ id: doc.id, placeId: pin.placeId, error: 'no details' });
      continue;
    }

    const patch = {
      servesBreakfast: details.serves_breakfast == null ? null : details.serves_breakfast,
      servesLunch: details.serves_lunch == null ? null : details.serves_lunch,
      servesDinner: details.serves_dinner == null ? null : details.serves_dinner,
      servesBrunch: details.serves_brunch == null ? null : details.serves_brunch,
      priceRange: buildPriceRange(details.price_range),
      placeEnrichmentVersion: PLACE_ENRICHMENT_VERSION,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!dryRun) {
      try {
        await doc.ref.update(patch);
        stats.updated += 1;
      } catch (err) {
        stats.failed += 1;
        stats.failures.push({ id: doc.id, placeId: pin.placeId, error: err.message });
      }
    } else {
      stats.updated += 1;
    }
  }

  stats.hasMore = snap.size === batchSize;

  return stats;
}

module.exports = { runBackfillMealTypes, PLACE_ENRICHMENT_VERSION };
