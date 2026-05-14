// One-time backfill that re-enriches existing pins from Google Places to
// capture meal-type booleans (servesBreakfast/Lunch/Dinner/Brunch) and
// priceRange — fields that were not persisted in the original pin pipeline.
//
// Paginated, idempotent, safe to re-run:
//   - skips pins that already have all four meal-type fields defined
//   - uses startAfterDocId to resume after a previous run
//   - dryRun=true returns the scan plan without writing anything
//   - reuses the existing place-details cache where possible
//
// Cost: ~$5 per 1k Place Details (Basic SKU). Cached pins (enriched within
// the last 30 days) are free — but cache entries written before the
// `priceRange` field-mask update will not contain the new field, so those
// pins will incur a cache miss on first run.

const { getPlaceDetails } = require('./places');

const DEFAULT_BATCH_SIZE = 50;

function hasAllMealFields(pin) {
  return (
    pin.servesBreakfast !== undefined &&
    pin.servesLunch !== undefined &&
    pin.servesDinner !== undefined &&
    pin.servesBrunch !== undefined
  );
}

async function runBackfillMealTypes({
  firestore,
  admin,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
  categoryFilter = 'food',
  includePriceRange = true,
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

    if (hasAllMealFields(pin) && (!includePriceRange || pin.priceRange !== undefined)) {
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
    };

    if (includePriceRange) {
      patch.priceRange = details.price_range
        ? {
            startUnits:
              details.price_range.start_price && details.price_range.start_price.units != null
                ? Number(details.price_range.start_price.units)
                : null,
            endUnits:
              details.price_range.end_price && details.price_range.end_price.units != null
                ? Number(details.price_range.end_price.units)
                : null,
            currencyCode:
              (details.price_range.start_price && details.price_range.start_price.currency_code) ||
              (details.price_range.end_price && details.price_range.end_price.currency_code) ||
              null,
          }
        : null;
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

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

module.exports = { runBackfillMealTypes };
