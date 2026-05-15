// One-time backfill that re-enriches existing pins from Google Places to
// capture every field in the Atmosphere SKU tier we already pay for —
// meal-type booleans, priceRange Money shape, full atmosphere/services
// data, business status, editorial summary, viewport, payment / parking
// / accessibility options, and current opening hours.
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
//   v4: full Atmosphere-tier capture — adds servesBeer/Wine/Cocktails/
//       Coffee/Dessert/VegetarianFood, outdoorSeating, goodFor*,
//       allowsDogs, restroom, menuForChildren, liveMusic, businessStatus,
//       editorialSummary, viewport, paymentOptions, parkingOptions,
//       accessibilityOptions, currentOpeningHours.
//   v3: priceRange persists startNanos/endNanos alongside units
//   v2: initial backfill (serves* + priceRange.units/currencyCode — lossy, deprecated)
const PLACE_ENRICHMENT_VERSION = 4;

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

// Maps every Atmosphere-tier field on `details` to its Pin-doc shape.
// Mirrors the client's mapAtmosphereFields in src/services/enrichmentService.ts.
function buildAtmospherePatch(details) {
  return {
    servesBreakfast: details.serves_breakfast == null ? null : details.serves_breakfast,
    servesLunch: details.serves_lunch == null ? null : details.serves_lunch,
    servesDinner: details.serves_dinner == null ? null : details.serves_dinner,
    servesBrunch: details.serves_brunch == null ? null : details.serves_brunch,
    servesBeer: details.serves_beer == null ? null : details.serves_beer,
    servesWine: details.serves_wine == null ? null : details.serves_wine,
    servesCocktails: details.serves_cocktails == null ? null : details.serves_cocktails,
    servesCoffee: details.serves_coffee == null ? null : details.serves_coffee,
    servesDessert: details.serves_dessert == null ? null : details.serves_dessert,
    servesVegetarianFood:
      details.serves_vegetarian_food == null ? null : details.serves_vegetarian_food,
    outdoorSeating: details.outdoor_seating == null ? null : details.outdoor_seating,
    goodForChildren: details.good_for_children == null ? null : details.good_for_children,
    goodForGroups: details.good_for_groups == null ? null : details.good_for_groups,
    allowsDogs: details.allows_dogs == null ? null : details.allows_dogs,
    restroom: details.restroom == null ? null : details.restroom,
    menuForChildren: details.menu_for_children == null ? null : details.menu_for_children,
    liveMusic: details.live_music == null ? null : details.live_music,
    businessStatus: details.business_status || null,
    editorialSummary: details.editorial_summary
      ? {
          text: details.editorial_summary.text == null ? null : details.editorial_summary.text,
          languageCode:
            details.editorial_summary.language_code == null
              ? null
              : details.editorial_summary.language_code,
        }
      : null,
    viewport: details.viewport
      ? {
          low: details.viewport.low || null,
          high: details.viewport.high || null,
        }
      : null,
    paymentOptions: details.payment_options
      ? {
          acceptsCreditCards: details.payment_options.accepts_credit_cards ?? null,
          acceptsDebitCards: details.payment_options.accepts_debit_cards ?? null,
          acceptsCashOnly: details.payment_options.accepts_cash_only ?? null,
          acceptsNfc: details.payment_options.accepts_nfc ?? null,
        }
      : null,
    parkingOptions: details.parking_options
      ? {
          freeParkingLot: details.parking_options.free_parking_lot ?? null,
          paidParkingLot: details.parking_options.paid_parking_lot ?? null,
          freeStreetParking: details.parking_options.free_street_parking ?? null,
          paidStreetParking: details.parking_options.paid_street_parking ?? null,
          valetParking: details.parking_options.valet_parking ?? null,
          freeGarageParking: details.parking_options.free_garage_parking ?? null,
          paidGarageParking: details.parking_options.paid_garage_parking ?? null,
        }
      : null,
    accessibilityOptions: details.accessibility_options
      ? {
          wheelchairAccessibleParking:
            details.accessibility_options.wheelchair_accessible_parking ?? null,
          wheelchairAccessibleEntrance:
            details.accessibility_options.wheelchair_accessible_entrance ?? null,
          wheelchairAccessibleRestroom:
            details.accessibility_options.wheelchair_accessible_restroom ?? null,
          wheelchairAccessibleSeating:
            details.accessibility_options.wheelchair_accessible_seating ?? null,
        }
      : null,
    currentOpeningPeriods: details.current_opening_periods || null,
    currentWeekdayDescriptions: details.current_weekday_descriptions || null,
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
      ...buildAtmospherePatch(details),
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
