const { admin, firestore } = require('./lib/firestore');
const { runYtDlp } = require('./lib/ytdlp');
const { fetchTikTokPhotoPost, isTikTokPhotoUrl } = require('./lib/tiktokPhoto');
const { fetchInstagramCarouselPost, isInstagramPostUrl } = require('./lib/instagramCarousel');
const { fetchInstagramReelPost, isInstagramReelUrl } = require('./lib/instagramReel');
const { extractPlacesFromSlides } = require('./lib/vision');
const { normalizePlaceName, dedupe, parseMentionedAccounts } = require('./lib/placeNameNormalize');
const { resolveOneRedirect, isShortSocialUrl } = require('./lib/urlResolve');
const { decodeHtmlEntities, cleanSocialText } = require('./enrich/utils');
const { extractDomain, determineSourceApp, extractContentId, normalizeUrl } = require('./enrich/urlUtils');
const {
  fetchOGMetadata,
  resolveShortUrl,
  isGoogleMapsUrl,
  parseGoogleMapsUrl,
} = require('./enrich/ogMetadata');
const {
  extractLocationQuery,
  extractLocationFromComponents,
  extractLocation,
  extractPinMarker,
} = require('./enrich/locationParser');
const { calculateConfidence } = require('./enrich/confidence');
const { mapToCategory } = require('./enrich/categories');

// Combines (de-duped, string-only) the candidate type arrays from multiple
// Places API sources. Empty arrays are falsy in business sense but truthy
// in JS — `||` chains silently swallow that, so we explicitly merge.
// Union (not "first-populated") so a generic top.types like ['establishment']
// can't shadow a richer details.types like ['italian_restaurant'].
function unionTypes(...candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    for (const t of c) {
      if (typeof t === 'string' && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}
const { extractCuisine } = require('./enrich/cuisine');
const { searchGooglePlaces, getPlaceDetails, findPlaceFromUrl } = require('./enrich/places');
const { assertSaveReason } = require('./lib/saveReason');
const { distanceKm } = require('./lib/geo');
const { aiExtractPlaces, aiExtractPlace, aiVerifyPlace } = require('./enrich/ai');
const { sendPushForJob } = require('./lib/push');

const ts = () => (admin && admin.firestore && admin.firestore.FieldValue.serverTimestamp());

async function setJob(jobId, data) {
  if (!firestore) return;
  await firestore.collection('enrichmentJobs').doc(jobId).set(data, { merge: true });
}

async function updateJob(jobId, data) {
  if (!firestore) return;
  await firestore.collection('enrichmentJobs').doc(jobId).set({ ...data, updatedAt: ts() }, { merge: true });
}

// Best-effort classification from the error message. Lets the team alert on
// dependency outages vs. real no-signal posts without parsing logs.
function classifyError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/timeout|etimedout|esockettimedout/.test(msg)) return 'dependency_timeout';
  if (/429|rate.?limit|quota|exceeded/.test(msg)) return 'quota_exhausted';
  if (/403|forbidden|blocked|access.?denied/.test(msg)) return 'blocked';
  if (/parse|json|invalid/.test(msg)) return 'parse_error';
  if (/enotfound|econnrefused|network/.test(msg)) return 'dependency_error';
  return 'dependency_error';
}

// Appends a stage-failure record to the job doc so silent fallbacks
// (vision/IG/Places/etc.) become attributable in Firestore. Uses a concrete
// Timestamp instead of serverTimestamp() because Firestore rejects sentinel
// values inside arrayUnion items.
async function recordStageFailure(jobId, { stage, kind, message }) {
  if (!firestore || !jobId) return;
  try {
    await updateJob(jobId, {
      stageFailures: admin.firestore.FieldValue.arrayUnion({
        stage,
        kind,
        message: String(message || '').slice(0, 500),
        at: admin.firestore.Timestamp.fromMillis(Date.now()),
      }),
    });
  } catch (err) {
    console.warn(`recordStageFailure write failed for ${jobId}:`, err.message || err);
  }
}

async function findPinByUrl(userId, url) {
  if (!firestore) return null;
  const normalized = normalizeUrl(url);
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('url', '==', url)
    .limit(1)
    .get();
  if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };

  const byNormalized = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('url', '==', normalized)
    .limit(1)
    .get();
  if (!byNormalized.empty) return { id: byNormalized.docs[0].id, ...byNormalized.docs[0].data() };
  return null;
}

async function findPinByContentId(userId, contentId) {
  if (!firestore || !contentId) return null;
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const pinUrl = data.url;
    if (pinUrl && extractContentId(pinUrl) === contentId) {
      return { id: doc.id, ...data };
    }
    // A video appended to sources[] by the duplicate-place flow must also
    // count as "already processed" — pin.url only covers the creating video.
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.some((s) => s && s.url && extractContentId(s.url) === contentId)) {
      return { id: doc.id, ...data };
    }
  }
  return null;
}

async function findPinByPlaceId(userId, placeId) {
  if (!firestore || !placeId) return null;
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('placeId', '==', placeId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Server-side mirror of the client lookupOrCreateTripSignal in
// analyticsService.ts. Same deterministic doc ID scheme so the two
// sides land on the same /tripSignals/{id} doc. Race-safe via
// firestore.runTransaction (admin SDK).
function computeTripSignalId(userId, city, country) {
  // Sanitize Firestore document IDs: strip path-illegal chars (/ \ .) and
  // unicode control characters before collapsing whitespace. A city like
  // "Donostia / San Sebastián" would otherwise survive as
  // "donostia_/_san_sebastián" — which Firestore rejects as a multi-segment
  // path. Accents are preserved on purpose: changing them would orphan
  // existing /tripSignals docs for cities like "São Paulo".
  // Applied to userId too even though Firebase Auth UIDs are
  // alphanumeric today — defense in depth (per implementation-review 1b).
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[/\\.\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  const normCity = norm(city);
  const normCountry = norm(country);
  const normUid = norm(userId);
  // Reject strings that normalize to empty (e.g. "/", "...", "\t\n") so we
  // don't synthesize doc IDs like `uid__country` that collide with valid
  // empty-city saves (per implementation-review 2a).
  if (!normCity || !normCountry || !normUid) return null;
  return `${normUid}_${normCity}_${normCountry}`;
}

// Defense-in-depth: even with sanitized signalId, the call to `.doc()` is
// synchronous and throws on illegal paths. Wrap it in try/catch so future
// gaps in sanitization fail soft (returns null) instead of bubbling up to
// runEnrichment's outer catch and marking the whole job failed.
// Used by both serverLookupOrCreateTripSignal AND serverRecordTripSignalSave.
function safeSignalIdRef(firestore, signalId) {
  if (!firestore || !signalId) return null;
  try {
    return firestore.collection('tripSignals').doc(signalId);
  } catch (err) {
    console.warn('safeSignalIdRef rejected signalId:', signalId, err.message);
    return null;
  }
}

const TRIP_SIGNAL_STATUSES = ['planning', 'traveling', 'returned'];

async function serverLookupOrCreateTripSignal({ userId, city, country }) {
  if (!firestore || !city || !country) return null;
  const signalId = computeTripSignalId(userId, city, country);
  // computeTripSignalId returns null when any segment normalizes to empty.
  if (!signalId) return null;
  const signalRef = safeSignalIdRef(firestore, signalId);
  if (!signalRef) return null;
  try {
    return await firestore.runTransaction(async (txn) => {
      const snap = await txn.get(signalRef);
      if (snap.exists) {
        const data = snap.data() || {};
        const status = TRIP_SIGNAL_STATUSES.includes(data.status)
          ? data.status
          : 'planning';
        return { tripSignalId: signalId, status };
      }
      txn.set(signalRef, {
        userId,
        city,
        country,
        status: 'planning',
        confidence: 'low',
        pinCount: 0,
        categories: [],
        createdAt: ts(),
        updatedAt: ts(),
        lastSaveDate: null,
      });
      return { tripSignalId: signalId, status: 'planning' };
    });
  } catch (err) {
    console.warn('serverLookupOrCreateTripSignal failed:', err.message);
    return null;
  }
}

// Helper to invoke recordTripSignalSave only on a fresh pin write.
// Codex review on Task 33 — duplicates (alreadyExists: true) must not
// double-count aggregates. New writes only.
// Returns a promise the caller awaits; on failure, attributes the silent
// undercount to the job doc as a stage failure (so the drift becomes visible
// in Firestore rather than only in server logs). Used to be fire-and-forget
// per the Task 33 review note above, but Codex hardening flagged the silent
// undercount risk — observable failure beats unobservable correctness loss.
function recordTripSignalSaveIfNew(pin, writeResult, jobId) {
  if (!pin || !writeResult || writeResult.alreadyExists) return Promise.resolve();
  if (!pin.tripSignalIdAtSave) return Promise.resolve();
  return serverRecordTripSignalSave({
    tripSignalId: pin.tripSignalIdAtSave,
    category: pin.category,
  }).catch((err) => {
    console.warn('serverRecordTripSignalSave failed:', err.message);
    return recordStageFailure(jobId, {
      stage: 'trip_signal_aggregate',
      kind: classifyError(err),
      message: err.message,
    });
  });
}

async function serverRecordTripSignalSave({ tripSignalId, category }) {
  if (!firestore || !tripSignalId) return;
  const signalRef = safeSignalIdRef(firestore, tripSignalId);
  if (!signalRef) return;
  await signalRef.update({
    pinCount: admin.firestore.FieldValue.increment(1),
    lastSaveDate: ts(),
    categories: admin.firestore.FieldValue.arrayUnion(category),
    updatedAt: ts(),
  });
}

// Reads the saving user's homeLocation from /users/{userId}. Returns
// the structured object or null on any failure (no user doc, missing
// field, malformed shape, network error). Validation mirrors the client
// coerceHomeLocation tightening from commit 85bec33 — Codex flagged the
// loose checks there and the same finite-coord + bounds invariants apply.
async function getUserHomeLocation(userId) {
  if (!firestore) return null;
  try {
    const snap = await firestore.collection('users').doc(userId).get();
    if (!snap.exists) return null;
    const home = (snap.data() || {}).homeLocation;
    if (
      !home ||
      typeof home !== 'object' ||
      typeof home.latitude !== 'number' ||
      typeof home.longitude !== 'number' ||
      !Number.isFinite(home.latitude) ||
      !Number.isFinite(home.longitude) ||
      home.latitude < -90 ||
      home.latitude > 90 ||
      home.longitude < -180 ||
      home.longitude > 180
    ) {
      return null;
    }
    return { latitude: home.latitude, longitude: home.longitude };
  } catch (err) {
    console.warn('getUserHomeLocation failed:', err.message);
    return null;
  }
}

const roundKm = (d) => Math.round(d * 10) / 10;

// Mirror of client's mapAtmosphereFields (src/services/enrichmentService.ts:66-132).
// Transforms server-side snake_case Place Details into the client Pin camelCase
// shape so server-built candidates carry the full v3+ Atmosphere field set.
// Without this, every multi-place candidate reaches the client with
// `businessStatus === undefined`, which trips the listener's
// `looksLikePreV3Server` heuristic and forces a redundant getPlaceDetails
// refetch on every save (paid call + extra failure surface). Keep this
// shape in sync with the client mirror until @a13xlin96/mapd-shared lands.
function mapAtmosphereFields(details) {
  // Defensive: callers may invoke with null/undefined; produce the all-null
  // shape rather than throwing (per implementation-review 1c).
  details = details || {};
  return {
    servesBreakfast: details.serves_breakfast ?? null,
    servesLunch: details.serves_lunch ?? null,
    servesDinner: details.serves_dinner ?? null,
    servesBrunch: details.serves_brunch ?? null,
    servesBeer: details.serves_beer ?? null,
    servesWine: details.serves_wine ?? null,
    servesCocktails: details.serves_cocktails ?? null,
    servesCoffee: details.serves_coffee ?? null,
    servesDessert: details.serves_dessert ?? null,
    servesVegetarianFood: details.serves_vegetarian_food ?? null,
    outdoorSeating: details.outdoor_seating ?? null,
    goodForChildren: details.good_for_children ?? null,
    goodForGroups: details.good_for_groups ?? null,
    allowsDogs: details.allows_dogs ?? null,
    restroom: details.restroom ?? null,
    menuForChildren: details.menu_for_children ?? null,
    liveMusic: details.live_music ?? null,
    businessStatus: details.business_status ?? null,
    editorialSummary: details.editorial_summary
      ? {
          text: details.editorial_summary.text ?? null,
          languageCode: details.editorial_summary.language_code ?? null,
        }
      : null,
    viewport: details.viewport
      ? {
          low: details.viewport.low ?? null,
          high: details.viewport.high ?? null,
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
    currentOpeningPeriods: details.current_opening_periods ?? null,
    currentWeekdayDescriptions: details.current_weekday_descriptions ?? null,
  };
}

// Mirror of client's priceRange shaping (enrichmentJobsListener.ts:119-142).
// Google Places returns price_range with snake_case start_price/end_price,
// nanos as bigint-stringified ints, and currency_code on each side. Pin's
// schema wants flat camelCase startUnits/startNanos/endUnits/endNanos/currencyCode.
function mapPriceRange(priceRangeRaw) {
  if (!priceRangeRaw) return null;
  // Guard NaN: Number('abc') and Number(undefined) yield NaN, which Firestore
  // rejects. Per implementation-review 2f. Number.isFinite handles bigint
  // strings (Number('1000000000') === 1e9, finite) AND rejects junk.
  const toNum = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    startUnits: toNum(priceRangeRaw.start_price?.units),
    startNanos: toNum(priceRangeRaw.start_price?.nanos),
    endUnits: toNum(priceRangeRaw.end_price?.units),
    endNanos: toNum(priceRangeRaw.end_price?.nanos),
    currencyCode:
      priceRangeRaw.start_price?.currency_code ??
      priceRangeRaw.end_price?.currency_code ??
      null,
  };
}

async function buildPinFromDetails({ url, userId, ogData, details, topResult, category, location, confidenceScore, saveReason }) {
  // Pre-write invariant: every server pin construction path must declare
  // its saveReason explicitly so saveOrigin always reflects how the pin
  // entered the system. Codex review on Task K flagged the helper-only
  // ship — wiring it here closes that gap on the actual write boundary.
  assertSaveReason(saveReason);

  const sourceDomain = extractDomain(url);
  const sourceApp = determineSourceApp(url);
  // Canonical type set: union of every signal Google handed us. Used as
  // the single source of truth for persisted `types`, `cuisine`, and the
  // category that was already computed at the call site from the same
  // union. Codex R4 caught the consistency gap where persisted types
  // diverged from category/cuisine and broke downstream re-derivation.
  const unionedTypes = unionTypes(details && details.types, topResult && topResult.types);
  // Optional chaining throughout — topResult from text search may lack
  // geometry, and details may be null when Places returned nothing. Without
  // ?., `topResult.geometry.location.lat` throws on missing geometry,
  // which the F3 details=null regression test exposed.
  const lat = details?.geometry?.location?.lat ?? topResult?.geometry?.location?.lat ?? null;
  const lng = details?.geometry?.location?.lng ?? topResult?.geometry?.location?.lng ?? null;

  // Resolve trip-signal context + home-distance in parallel. Both may
  // return null (no city/country, no homeLocation, transaction failure)
  // — pin construction proceeds with null Phase 1 fields in those cases.
  const city = (location && location.city) || null;
  const country = (location && location.country) || null;
  const [tripContext, homeLocation] = await Promise.all([
    serverLookupOrCreateTripSignal({ userId, city, country }),
    getUserHomeLocation(userId),
  ]);

  const distanceFromHomeCityKm =
    homeLocation && typeof lat === 'number' && typeof lng === 'number'
      ? roundKm(distanceKm(homeLocation.latitude, homeLocation.longitude, lat, lng))
      : null;

  // NOTE: trip-signal aggregate bump (serverRecordTripSignalSave) does
  // NOT fire here. Codex review on Task 33 flagged that incrementing
  // pinCount + arrayUnion(category) BEFORE the pin write commits would
  // inflate aggregates whenever the write later fails — duplicate
  // (alreadyExists), needs_selection (candidates whose pins the user
  // rejects), or any transient writePinTransactional error. The bump
  // is now the caller's responsibility, fired only after
  // writePinTransactional confirms alreadyExists === false. The
  // lookup itself stays here (idempotent — at worst creates a phantom
  // pinCount:0 doc that the next real save picks up).

  return {
    userId,
    url,
    sourceApp,
    sourceDomain,
    ogTitle: decodeHtmlEntities((ogData && ogData.title) || ''),
    ogDescription: decodeHtmlEntities((ogData && ogData.description) || ''),
    ogImage: (ogData && ogData.image) || '',
    placeId: (details && topResult && topResult.place_id) || (topResult && topResult.place_id) || null,
    placeName: (details && details.name) || (topResult && topResult.name) || '',
    formattedAddress: (details && details.formatted_address) || (topResult && topResult.formatted_address) || '',
    latitude: lat,
    longitude: lng,
    category,
    rating: (details && details.rating) || (topResult && topResult.rating) || null,
    userRatingsTotal: (details && details.user_ratings_total) || (topResult && topResult.user_ratings_total) || null,
    priceLevel: (details && details.price_level) || null,
    shortFormattedAddress: (details && details.short_formatted_address) || null,
    primaryType: (details && details.primary_type) || null,
    // Persisted as the union so downstream re-derivation jobs (the backfill,
    // a future repair pass) see the same input the original write
    // classified on. null-when-empty preserved for backward-compat with
    // existing Pin schema consumers.
    types: unionedTypes.length > 0 ? unionedTypes : null,
    cuisine: extractCuisine(unionedTypes, (details && details.primary_type) || null),
    dineIn: details ? details.dine_in : null,
    takeout: details ? details.takeout : null,
    delivery: details ? details.delivery : null,
    reservable: details ? details.reservable : null,
    // v3+ Atmosphere fields. Server fetches these in places.js's field mask
    // — write them through to the candidate so client-side multi-place save
    // doesn't trigger a redundant Place Details refetch (skew-recovery path).
    // CRITICAL (implementation-review 1a): spread the all-null shape even
    // when details is missing. The client's pre-v3 detector at
    // enrichmentJobsListener.ts:109 triggers on `businessStatus === undefined`
    // — writing `{}` here would leave businessStatus undefined and re-arm
    // Bug 2 on every single-place fallback path. mapAtmosphereFields({})
    // produces all-null values, which the detector correctly ignores.
    ...mapAtmosphereFields(details),
    priceRange: mapPriceRange(details ? details.price_range : null),
    openingPeriods: (details && details.opening_periods) || null,
    weekdayDescriptions: (details && details.weekday_descriptions) || null,
    utcOffsetMinutes: details && typeof details.utc_offset_minutes === 'number' ? details.utc_offset_minutes : null,
    website: (details && details.website) || null,
    phoneNumber: (details && details.formatted_phone_number) || null,
    status: 'pinned',
    confidenceScore: confidenceScore == null ? 85 : confidenceScore,
    listIds: [],
    country,
    region: (location && location.region) || null,
    city,
    visited: false,
    wouldGoBack: null,
    visitedAt: null,
    visitNote: null,
    serverEnriched: true,
    // Phase 1 rec/ad signals
    saveOrigin: saveReason,
    tripSignalIdAtSave: tripContext ? tripContext.tripSignalId : null,
    savedAtTripStatus: tripContext ? tripContext.status : null,
    distanceFromUserAtSaveKm: null,
    distanceFromHomeCityKm,
    recAttributionId: null,
  };
}

// Shared "duplicate place, maybe-new link" computation. Dedupe by normalized
// URL OR content ID against pin.url and every sources[] entry; append the
// source otherwise. Also upgrades pin.url to the incoming (canonical) URL
// when pin.url lacks a content ID, so future reshares of this video stay
// content-ID-matchable — TikTok mints a different short URL on every share.
// Mirrors the client's addSourceToPin dedupe (pinsStore.ts) and the legacy
// pipeline's URL-upgrade step (enrichmentTask.ts). Pure: returns the update
// to write (possibly empty) and whether a source would be appended.
function computeSourceAppend(data, source) {
  const newContentId = extractContentId(source.url);
  const newNormalized = normalizeUrl(source.url);
  const sameLink = (u) => {
    if (!u) return false;
    if (normalizeUrl(u) === newNormalized) return true;
    const cid = extractContentId(u);
    return !!(newContentId && cid && cid === newContentId);
  };
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const alreadyHas = sameLink(data.url) || sources.some((s) => s && sameLink(s.url));
  const update = {};
  if (!alreadyHas) update.sources = [...sources, source];
  if (!extractContentId(data.url) && newContentId) update.url = source.url;
  return { update, sourceAdded: !alreadyHas };
}

// Append a share to a pin found OUTSIDE writePinTransactional (content-ID
// dedup, AI candidate-loop skip, OG-fallback duplicate). Own transaction so
// a concurrent enrichment appending to the same pin can't clobber sources[].
// Returns whether a new source landed; failures degrade to false — the job
// still finishes as 'duplicate', we just don't claim "new link added".
async function appendSourceToExistingPin(pinId, source) {
  if (!firestore || !pinId) return false;
  const entry = { ...source, addedAt: new Date() };
  try {
    return await firestore.runTransaction(async (txn) => {
      const ref = firestore.collection('pins').doc(pinId);
      const snap = await txn.get(ref);
      if (!snap.exists) return false;
      const { update, sourceAdded } = computeSourceAppend(snap.data() || {}, entry);
      if (Object.keys(update).length > 0) {
        txn.update(ref, { ...update, updatedAt: ts() });
      }
      return sourceAdded;
    });
  } catch (err) {
    console.warn(`appendSourceToExistingPin failed for ${pinId}:`, err && err.message);
    return false;
  }
}

// Transactional pin write — re-checks placeId, raw URL, and normalized URL
// dedup INSIDE the txn so two concurrent jobs (different jobIds, same place)
// can't both pass the pre-AI dedup check and write two pins. Mirrors the
// fallback list of findPinByUrl (raw → normalized) for symmetry.
// Returns { pinId, alreadyExists }. Caller must surface 'duplicate' status
// when alreadyExists is true.
async function writePinTransactional(pin, _ogData) {
  if (!firestore) return null;
  const source = {
    url: pin.url,
    ogTitle: pin.ogTitle,
    ogImage: pin.ogImage,
    sourceApp: pin.sourceApp,
    sourceDomain: pin.sourceDomain,
    addedAt: new Date(),
  };
  const normalizedUrl = normalizeUrl(pin.url);
  // Duplicate place, possibly a NEW video about it — attach the share as an
  // additional source on the existing pin instead of dropping it (the old
  // client pipeline did this via addSourceToPin; the server path lost it in
  // the cloud-function migration).
  const appendSourceToDoc = (txn, docSnap) => {
    const { update, sourceAdded } = computeSourceAppend(docSnap.data() || {}, source);
    if (Object.keys(update).length > 0) {
      txn.update(docSnap.ref, { ...update, updatedAt: ts() });
    }
    return sourceAdded;
  };
  return await firestore.runTransaction(async (txn) => {
    if (pin.placeId) {
      const placeSnap = await txn.get(
        firestore.collection('pins')
          .where('userId', '==', pin.userId)
          .where('placeId', '==', pin.placeId)
          .limit(1)
      );
      if (!placeSnap.empty) {
        const sourceAdded = appendSourceToDoc(txn, placeSnap.docs[0]);
        return { pinId: placeSnap.docs[0].id, alreadyExists: true, sourceAdded };
      }
    }
    const rawUrlSnap = await txn.get(
      firestore.collection('pins')
        .where('userId', '==', pin.userId)
        .where('url', '==', pin.url)
        .limit(1)
    );
    if (!rawUrlSnap.empty) {
      const sourceAdded = appendSourceToDoc(txn, rawUrlSnap.docs[0]);
      return { pinId: rawUrlSnap.docs[0].id, alreadyExists: true, sourceAdded };
    }
    if (normalizedUrl !== pin.url) {
      const normSnap = await txn.get(
        firestore.collection('pins')
          .where('userId', '==', pin.userId)
          .where('url', '==', normalizedUrl)
          .limit(1)
      );
      if (!normSnap.empty) {
        const sourceAdded = appendSourceToDoc(txn, normSnap.docs[0]);
        return { pinId: normSnap.docs[0].id, alreadyExists: true, sourceAdded };
      }
    }
    const ref = firestore.collection('pins').doc();
    txn.set(ref, { ...pin, sources: [source], createdAt: ts(), updatedAt: ts() });
    return { pinId: ref.id, alreadyExists: false };
  });
}

/** Google Maps URL: parse → Places search → single pin. */
async function handleGoogleMapsUrl(url, userId) {
  let resolved = url;
  if (url.includes('goo.gl') || url.includes('maps.app')) {
    resolved = await resolveShortUrl(url);
  }
  const parsed = parseGoogleMapsUrl(resolved);
  if (!parsed) return null;

  let top = await findPlaceFromUrl(resolved);
  if (!top) {
    const results = await searchGooglePlaces(parsed.placeName);
    if (results.length > 0) top = results[0];
  }
  if (!top) return null;

  const details = await getPlaceDetails(top.place_id);
  const category = mapToCategory(
    unionTypes(top.types, details && details.types),
    (details && details.primary_type) || null,
  );
  const location = details && details.address_components
    ? extractLocationFromComponents(details.address_components)
    : extractLocation((details && details.formatted_address) || top.formatted_address || '');

  return await buildPinFromDetails({
    url,
    userId,
    ogData: { title: parsed.placeName, description: '', image: '' },
    details,
    topResult: top,
    category,
    location,
    confidenceScore: 90,
    saveReason: 'enrichment',
  });
}

/** AI-first pipeline: extract, dedup, AI places, Places API, return candidates. */
async function runAIPipeline({ jobId, url, userId, captionText }) {
  const isSocial = url.includes('instagram.com') || url.includes('tiktok.com');

  // Resolve social short URLs once so the TikTok-photo router below can see
  // the canonical /photo/ path. Without this, /t/ short URLs slip past the
  // isTikTokPhotoUrl() check and fall through to runYtDlp, which doesn't
  // support TikTok photo posts.
  let resolvedUrl = url;
  if (isSocial && isShortSocialUrl(url)) {
    try { resolvedUrl = await resolveOneRedirect(url); } catch {}
  }

  let extracted = null;
  if (isSocial) {
    try {
      if (isTikTokPhotoUrl(resolvedUrl)) {
        extracted = await fetchTikTokPhotoPost(resolvedUrl);
      } else if (isInstagramPostUrl(resolvedUrl)) {
        try {
          extracted = await fetchInstagramCarouselPost(resolvedUrl);
        } catch (igErr) {
          console.warn('IG embed extract failed, falling back to yt-dlp:', igErr.message);
          recordStageFailure(jobId, { stage: 'instagram_carousel', kind: classifyError(igErr), message: igErr.message });
          extracted = await runYtDlp(url);
        }
      } else if (isInstagramReelUrl(resolvedUrl)) {
        // Reels go through OG-scrape of the canonical page first — Instagram
        // blocks yt-dlp on Render's IP for /reel/, but the canonical reel
        // page itself returns og:description with the caption from any IP.
        // Falls back to yt-dlp only if OG scrape fails (login wall, format drift).
        try {
          extracted = await fetchInstagramReelPost(resolvedUrl);
        } catch (reelErr) {
          console.warn('IG reel OG extract failed, falling back to yt-dlp:', reelErr.message);
          recordStageFailure(jobId, { stage: 'instagram_reel', kind: classifyError(reelErr), message: reelErr.message });
          extracted = await runYtDlp(url);
        }
      } else {
        extracted = await runYtDlp(url);
      }
    } catch (err) {
      console.warn('social extraction failed, falling back to OG scraping:', err.message);
      recordStageFailure(jobId, { stage: 'social_extraction', kind: classifyError(err), message: err.message });
    }
  }

  const ogData = extracted
    ? {
        title: extracted.title || '',
        description: extracted.description || captionText || '',
        image: extracted.thumbnail_url || '',
        url,
        siteName: extractDomain(url),
      }
    : await fetchOGMetadata(url);
  if (!extracted && captionText) ogData.description = `${ogData.description}\n${captionText}`.trim();

  // Content-ID dedup (after extract, when webpage_url is canonical)
  const canonicalUrl = (extracted && extracted.webpage_url) || resolvedUrl;
  const contentId = extractContentId(canonicalUrl);
  if (contentId) {
    const dup = await findPinByContentId(userId, contentId);
    if (dup) return { duplicate: dup, candidates: [], canonicalUrl, ogData };
  }

  // Parse @mentions from the caption and feed them into the AI prompt so
  // thin-caption photo carousels have a chance of hitting a venue handle.
  // The helper filters out obvious personal/creator handles upstream.
  const mentionedAccounts = parseMentionedAccounts(ogData.description || '');

  // AI extract places (multi) — text signals only
  const aiResult = await aiExtractPlaces({
    title: ogData.title,
    description: ogData.description,
    hashtags: extracted && extracted.hashtags,
    uploader: extracted && extracted.uploader,
    subtitles: extracted && extracted.subtitles,
    mentionedAccounts,
    collaborators: [], // yt-dlp doesn't currently surface IG Collab coauthors
  });

  // Vision pass for photo carousels. Fires whenever we have 2+ slide
  // images, not only when text AI returned empty — "10 best bars" listicle
  // carousels name one venue in caption and more on later slides. Vision
  // failure is swallowed so text-AI candidates still land as pins.
  const textPlaces = (aiResult && Array.isArray(aiResult.places)) ? aiResult.places : [];
  let visionPlaces = [];
  if (extracted && extracted.is_carousel && Array.isArray(extracted.slide_thumbnails) && extracted.slide_thumbnails.length >= 2) {
    try {
      const vres = await extractPlacesFromSlides({
        imageUrls: extracted.slide_thumbnails,
        contentId,
        caption: extracted.description || '',
        hashtags: extracted.hashtags || [],
        subtitles: extracted.subtitles || '',
      });
      visionPlaces = (vres.places || []).map((p) => ({
        name: p && typeof p === 'object' ? p.name : String(p || ''),
        city: p && typeof p === 'object' ? (p.location || '') : '',
        address: '',
        source: 'vision',
      }));
    } catch (err) {
      console.warn('vision extractPlacesFromSlides failed, continuing with text AI only:', err.message);
      recordStageFailure(jobId, { stage: 'vision', kind: classifyError(err), message: err.message });
      visionPlaces = [];
    }
  }

  // Merge text + vision candidates, dedup by normalized name (so
  // "Café Nowhere" and "cafe nowhere" don't double-pin).
  const allCandidates = dedupe(
    [...textPlaces, ...visionPlaces],
    (p) => normalizePlaceName(p.name),
  );

  const candidates = [];
  const existingMatches = [];
  if (allCandidates.length > 0) {
    for (const p of allCandidates) {
      const query = [p.name, p.address, p.city].filter(Boolean).join(' ');
      if (!query || query.trim().length < 3) continue;
      const results = await searchGooglePlaces(query);
      if (results.length === 0) continue;
      const top = results[0];
      // Per-place placeId dedup: skip if user already has this pin
      const existing = await findPinByPlaceId(userId, top.place_id);
      if (existing) {
        // Already pinned — not a candidate, but the caller appends this
        // share as a new source on the existing pin (the old client
        // pipeline's "Already on your map — new link added" behavior).
        existingMatches.push(existing);
        continue;
      }
      const details = await getPlaceDetails(top.place_id);
      if (!details) continue;
      const category = mapToCategory(
        unionTypes(top.types, details.types),
        details.primary_type || null,
      );
      const location = details.address_components
        ? extractLocationFromComponents(details.address_components)
        : extractLocation(details.formatted_address || top.formatted_address);
      candidates.push(await buildPinFromDetails({
        // Canonical, not the raw share URL — TikTok short URLs carry no
        // content ID, so a pin created with one is invisible to future
        // same-video dedup (the legacy client pipeline stored canonical).
        url: canonicalUrl,
        userId,
        ogData,
        details,
        topResult: top,
        category,
        location,
        confidenceScore: 85,
        saveReason: 'enrichment',
      }));
    }
  }

  return { duplicate: null, candidates, ogData, canonicalUrl, existingMatches };
}

/** OG-first fallback pipeline (port of client processUrl) — used when AI returns no places. */
async function runOGFallback({ url, userId, captionText, ogData }) {
  const title = ogData.title || '';
  const description = ogData.description || '';

  let searchQuery = '';

  const singleAI = await aiExtractPlace({ title, description });
  if (singleAI && singleAI.length > 3) searchQuery = singleAI;

  if (!searchQuery) {
    const pinMarker = extractPinMarker(decodeHtmlEntities(description)) || extractPinMarker(decodeHtmlEntities(title));
    if (pinMarker && pinMarker.length > 2) searchQuery = pinMarker;
  }

  if (!searchQuery) {
    const captionQuery = captionText ? extractLocationQuery(captionText, '') : '';
    const ogQuery = extractLocationQuery(title, description);
    if (captionQuery.length > 3) searchQuery = captionQuery;
    else if (ogQuery.length > 3) searchQuery = ogQuery;
  }

  const garbage = ['instagram', 'tiktok', 'youtube', 'facebook', 'twitter', 'x'];
  const isGarbage = garbage.includes(searchQuery.toLowerCase().trim()) || searchQuery.trim().length < 3;
  if (isGarbage) return null;

  let results = await searchGooglePlaces(searchQuery);
  let { place, score } = calculateConfidence(results, ogData);

  if (place && score < 60) {
    const verification = await aiVerifyPlace(ogData, place.name, place.formatted_address, place.types);
    if (!verification.match && verification.betterQuery) {
      const aiResults = await searchGooglePlaces(verification.betterQuery);
      const check = calculateConfidence(aiResults, ogData);
      if (check.place) {
        place = check.place;
        score = Math.max(check.score, 60);
        results = aiResults;
      }
    }
  }

  if (!place || score < 30) return null;

  const existing = await findPinByPlaceId(userId, place.place_id);
  if (existing) return { duplicate: existing };

  const details = await getPlaceDetails(place.place_id);
  const category = mapToCategory(
    unionTypes(place.types, details && details.types),
    (details && details.primary_type) || null,
  );
  const location = details && details.address_components
    ? extractLocationFromComponents(details.address_components)
    : extractLocation((details && details.formatted_address) || (place && place.formatted_address) || '');

  return {
    pin: await buildPinFromDetails({
      url,
      userId,
      ogData,
      details,
      topResult: place,
      category,
      location,
      confidenceScore: score,
      saveReason: 'enrichment',
    }),
  };
}

// Keeps `updatedAt` advancing while runEnrichment is alive so the orphan
// sweeper (which now checks `updatedAt`) won't race a slow-but-live worker.
// Returns a stop function the caller MUST invoke in a `finally`.
function startJobHeartbeat(jobId, intervalMs) {
  const ms = typeof intervalMs === 'number' ? intervalMs : 30 * 1000;
  const id = setInterval(() => {
    updateJob(jobId, {}).catch((err) => {
      console.warn(`heartbeat for ${jobId} failed:`, err && err.message);
    });
  }, ms);
  if (typeof id.unref === 'function') id.unref();
  return () => clearInterval(id);
}

async function runEnrichment(jobId, url, userId, captionText) {
  if (!firestore) {
    console.error('runEnrichment called but Firestore is not initialized');
    return;
  }

  const stopHeartbeat = startJobHeartbeat(jobId);

  // Terminal 'duplicate' writer. sourceAdded records whether this share's
  // link was appended to the existing pin as a new source — the client toast
  // and push copy say "new link added" instead of "already saved" when true.
  const finishDuplicate = async (existingPin, sourceAdded) => {
    const added = sourceAdded === true;
    await updateJob(jobId, { status: 'duplicate', existingPinId: existingPin.id, sourceAdded: added, completedAt: ts() });
    await sendPushForJob(jobId, userId, 'duplicate', { placeName: existingPin.placeName, pinId: existingPin.id, sourceAdded: added });
  };

  // Source entry for appending this share onto an existing pin. Always the
  // canonical URL (yt-dlp webpage_url) — TikTok short URLs carry no content
  // ID, so appending them would break future same-video dedup.
  const sourceEntryFor = (sourceUrl, ogData) => ({
    url: sourceUrl,
    ogTitle: (ogData && ogData.title) || '',
    ogImage: (ogData && ogData.image) || '',
    sourceApp: determineSourceApp(sourceUrl),
    sourceDomain: extractDomain(sourceUrl),
  });

  try {
    // 1. Raw-URL dedup — the exact same link is already pinned; nothing new
    // to attach.
    const existingByUrl = await findPinByUrl(userId, url);
    if (existingByUrl) {
      await finishDuplicate(existingByUrl, false);
      return;
    }

    // 2. Google Maps URL short-circuit
    if (isGoogleMapsUrl(url)) {
      const pin = await handleGoogleMapsUrl(url, userId);
      if (pin) {
        const result = await writePinTransactional(pin, { title: pin.placeName });
        await recordTripSignalSaveIfNew(pin, result, jobId);
        if (result.alreadyExists) {
          await finishDuplicate({ id: result.pinId, placeName: pin.placeName }, result.sourceAdded);
        } else {
          await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
          await sendPushForJob(jobId, userId, 'complete', { placeName: pin.placeName, pinId: result.pinId });
        }
        return;
      }
    }

    // 3. AI-first pipeline
    const ai = await runAIPipeline({ jobId, url, userId, captionText });
    if (ai.duplicate) {
      // Same video (content-ID match) — appendSourceToExistingPin no-ops
      // unless this canonical URL is genuinely new to the pin.
      const added = await appendSourceToExistingPin(
        ai.duplicate.id,
        sourceEntryFor(ai.canonicalUrl || url, ai.ogData),
      );
      await finishDuplicate(ai.duplicate, added);
      return;
    }

    // Places the AI found that are ALREADY pinned: attach this share as a
    // new source on each (old pipeline's "new link added" behavior). Done
    // before the candidate branches so the mixed case (some new, some
    // existing) appends too, not just the all-existing case.
    const existingMatches = Array.isArray(ai.existingMatches) ? ai.existingMatches : [];
    let appendedToExisting = false;
    for (const match of existingMatches) {
      const added = await appendSourceToExistingPin(
        match.id,
        sourceEntryFor(ai.canonicalUrl || url, ai.ogData),
      );
      appendedToExisting = appendedToExisting || added;
    }

    // Every place in the video is already pinned — terminal duplicate. Do
    // NOT fall through to the OG fallback: it would re-run AI + Places for
    // places we already matched, and can mis-resolve to a different place.
    if (ai.candidates.length === 0 && existingMatches.length > 0) {
      await finishDuplicate(existingMatches[0], appendedToExisting);
      return;
    }

    if (ai.candidates.length === 1) {
      const result = await writePinTransactional(ai.candidates[0], ai.ogData);
      await recordTripSignalSaveIfNew(ai.candidates[0], result, jobId);
      if (result.alreadyExists) {
        await finishDuplicate({ id: result.pinId, placeName: ai.candidates[0].placeName }, result.sourceAdded);
      } else {
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: ai.candidates[0].placeName, pinId: result.pinId });
      }
      return;
    }

    if (ai.candidates.length > 1) {
      await updateJob(jobId, {
        status: 'needs_selection',
        candidates: ai.candidates,
        ogTitle: (ai.ogData && ai.ogData.title) || '',
        ogImage: (ai.ogData && ai.ogData.image) || '',
        completedAt: ts(),
      });
      await sendPushForJob(jobId, userId, 'needs_selection');
      return;
    }

    // 4. OG-first fallback (single-place inference). Canonical URL for the
    // same reason as the AI candidates — the pin it builds must stay
    // content-ID-matchable.
    const fallback = await runOGFallback({ url: ai.canonicalUrl || url, userId, captionText, ogData: ai.ogData });
    if (fallback && fallback.duplicate) {
      const added = await appendSourceToExistingPin(
        fallback.duplicate.id,
        sourceEntryFor(ai.canonicalUrl || url, ai.ogData),
      );
      await finishDuplicate(fallback.duplicate, added);
      return;
    }
    if (fallback && fallback.pin) {
      const result = await writePinTransactional(fallback.pin, ai.ogData);
      await recordTripSignalSaveIfNew(fallback.pin, result, jobId);
      if (result.alreadyExists) {
        await finishDuplicate({ id: result.pinId, placeName: fallback.pin.placeName }, result.sourceAdded);
      } else {
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: fallback.pin.placeName, pinId: result.pinId });
      }
      return;
    }

    // 5. Give up
    await updateJob(jobId, {
      status: 'failed',
      error: 'No places could be extracted from this link',
      ogTitle: (ai.ogData && ai.ogData.title) || '',
      ogImage: (ai.ogData && ai.ogData.image) || '',
      completedAt: ts(),
    });
    await sendPushForJob(jobId, userId, 'failed');
  } catch (err) {
    console.error(`runEnrichment failed for job ${jobId}:`, err);
    try {
      await updateJob(jobId, {
        status: 'failed',
        error: String((err && err.message) || err).slice(0, 500),
        completedAt: ts(),
      });
      await sendPushForJob(jobId, userId, 'failed');
    } catch (writeErr) {
      console.error('Also failed to write failure status:', writeErr.message);
    }
  } finally {
    stopHeartbeat();
  }
}

module.exports = {
  runEnrichment,
  setJob,
  updateJob,
  buildPinFromDetails,
  // Exported for tests — not load-bearing public API.
  computeTripSignalId,
  safeSignalIdRef,
  mapAtmosphereFields,
  mapPriceRange,
  startJobHeartbeat,
  recordStageFailure,
  classifyError,
  recordTripSignalSaveIfNew,
  serverRecordTripSignalSave,
  writePinTransactional,
  findPinByContentId,
  appendSourceToExistingPin,
};
