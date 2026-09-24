const {classifyContentProvider,isYouTubeVideoUrl}=require('./lib/contentProvider');
const {executionFeatures}=require('./lib/engineRuntimeConfig');
const telemetry=require('./lib/engineTelemetry');
const {mediaEligibility,videoEligible,mergeCandidates}=require('./lib/media/mediaEligibility');
const {collectVideoEvidence}=require('./lib/media/videoEvidence');
const {withAnalysisRecovery}=require('./lib/media/analysisRecovery');
const metrics=require('./lib/engineMetrics');
const {createContentIndex}=require('./lib/contentIndex');
const useContentIndex=()=>jobContext.current()?.features?.versions?.contentIndexReader==='content-index-v1';
const {randomUUID} = require('crypto');
const {withLease} = require('./lib/providerRuntime');
const jobContext = require('./lib/jobContext');
const {getRetryContext,withOutcomeSummary,retainUnresolved} = require('./lib/retryContext');
const {rankPlaces,validCoordinates} = require('./enrich/confidence');
const {EngineError,asEngineError,failureOf} = require('./lib/engineError');
const ENGINE_VERSION = require('./lib/engineVersion');
const {extractPublicPost} = require('./lib/extraction');
const { persistThumbnail } = require('./lib/thumbnails');
const { admin, firestore } = require('./lib/firestore');
const { fetchInstagramReelPost, isInstagramReelUrl } = require('./lib/instagramReel');
const { extractPlacesFromSlides } = require('./lib/vision');
const { normalizePlaceName, dedupe, parseMentionedAccounts } = require('./lib/placeNameNormalize');
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
const { searchGooglePlaces, getPlaceDetails, getCachedPlaceDetails, findPlaceFromUrl } = require('./enrich/places');
const { assertSaveReason } = require('./lib/saveReason');
const { distanceKm } = require('./lib/geo');
const { aiExtractPlaces, aiExtractPlace, aiVerifyPlace } = require('./enrich/ai');
const {SERVER_PUBLIC_SCOPE}=require('./lib/sharedAiIdentity');
const { sendPushForJob } = require('./lib/push');
const { recordPinSaved } = require('./lib/interestProfile');
const {enqueueNewPin} = require('./lib/pinDetails');
const {notifyDetailWork} = require('./lib/pinDetailsWorker');
// Optional details are fetched only after a committed save. Older completed
// cache entries are still useful without another paid request.
const candidateDetails = async id => typeof getCachedPlaceDetails === 'function'
  ? getCachedPlaceDetails(id) : null;

const ts = () => (admin && admin.firestore && admin.firestore.FieldValue.serverTimestamp());

async function setJob(jobId, data) {
  if (!firestore) return;
  await firestore.collection('enrichmentJobs').doc(jobId).set(data, { merge: true });
}

async function updateJob(jobId, data) {
  if (!firestore) return;
  data = withAnalysisRecovery(withOutcomeSummary(data,jobContext.current()),jobContext.current());
  const payload = {...data,engineVersion:ENGINE_VERSION,updatedAt:ts()};
  const ref = firestore.collection('enrichmentJobs').doc(jobId);
  if(jobContext.current()?.leaseOwner) {
    await firestore.runTransaction(async txn=>{await jobContext.assertActive(txn,{allowExpired:data.status==='failed'});txn.set(ref,payload,{merge:true});});
  } else await ref.set(payload,{merge:true});
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
  if(useContentIndex()) {
    const found=await createContentIndex({db:firestore}).lookup({uid:userId,contentId});
    metrics.current()?.operation('lookupReads',found.reads.account+found.reads.rows+found.reads.pins);
    if(found.indexReady || found.pins.length || process.env.ENGINE_ALLOW_LEGACY_CONTENT_SCAN!=='true') return found.pins[0] || null;
  }
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
    detailsSchemaVersion: 1,
    detailsState: details ? 'complete' : 'pending',
    detailsRevision: 1,
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
function writeContentRows(txn,pinId,pin) {
  const {identities,indexRows}=require('./functions/lib/contentIdentity');
  for(const row of indexRows(pin.userId,pinId,identities(pin))) txn.set(firestore.collection('pinContentIndex').doc(row.id),row);
}

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
  // Upgrade is scoped to SOCIAL pins whose url is a short link (no content
  // ID) — the TikTok /t/XXXX case the upgrade exists for. Non-social pins
  // (Google Maps, websites) keep their primary URL: rewriting it to a later
  // video would be a hidden semantic migration, and their dedup doesn't
  // depend on content IDs anyway (placeId + the appended source cover it).
  const existingApp = determineSourceApp(data.url || '');
  const upgradeEligible = existingApp === 'tiktok' || existingApp === 'instagram' || existingApp === 'youtube';
  if (upgradeEligible && !extractContentId(data.url) && newContentId) update.url = source.url;
  return { update, sourceAdded: !alreadyHas };
}

// Append a share to a pin found OUTSIDE writePinTransactional (content-ID
// dedup, AI candidate-loop skip, OG-fallback duplicate). Own transaction so
// a concurrent enrichment appending to the same pin can't clobber sources[].
// False means the source was already present. A failed write must remain an
// unresolved action; it cannot be acknowledged as a completed duplicate.
async function appendSourceToExistingPin(pinId, source) {
  if (!firestore || !pinId) return false;
  const entry = { ...source, addedAt: new Date() };
  try {
    return await firestore.runTransaction(async (txn) => {
      await jobContext.assertActive(txn);
      const ref = firestore.collection('pins').doc(pinId);
      const snap = await txn.get(ref);
      if (!snap.exists || (jobContext.current()?.userId && snap.data().userId!==jobContext.current().userId)) {
        throw new EngineError('no_verified_match', { stage: 'save' });
      }
      const { update, sourceAdded } = computeSourceAppend(snap.data() || {}, entry);
      if (Object.keys(update).length > 0) {
        txn.update(ref, { ...update, updatedAt: ts() });
      }
      writeContentRows(txn,pinId,{...snap.data(),...update});
      return sourceAdded;
    });
  } catch (err) {
    const error = asEngineError(err, {stage:'save'}), context = jobContext.current();
    if (context?.outcomes) context.outcomes = context.outcomes.map(outcome => {
      if (outcome.pinId !== pinId || outcome.status !== 'existing') return outcome;
      const { pinId: _unconfirmedId, ...evidence } = outcome;
      return { ...evidence, status:'unresolved', failure:failureOf(error) };
    });
    throw error;
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
    writeContentRows(txn,docSnap.id,{...docSnap.data(),...update});
    return sourceAdded;
  };
  const result = await telemetry.stage('save', () => firestore.runTransaction(async (txn) => {
    await jobContext.assertActive(txn);
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
    if (!jobContext.current()?.retry?.resumePlaces && !jobContext.current()?.allowMultiplePlaces && !useContentIndex()) {
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
    }
    const ref = firestore.collection('pins').doc();
    txn.set(ref, { ...pin, sources: [source], createdAt: ts(), updatedAt: ts() });
    writeContentRows(txn,ref.id,{...pin,sources:[source]});
    enqueueNewPin(txn,firestore,admin,ref,pin);
    return { pinId: ref.id, alreadyExists: false };
  }));
  if (!result.alreadyExists) notifyDetailWork();
  return result;
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

  const details = await candidateDetails(top.place_id);
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
  const retry = jobContext.current()?.retry || {};
  const provider=classifyContentProvider(url);
  const mediaEnabled=videoEligible({features:jobContext.current()?.features,url});
  const isSocial=['instagram','tiktok'].includes(provider) || (jobContext.current()?.features?.versions?.languageRouting==='multilingual-v1' && isYouTubeVideoUrl(url));

  let extracted = null, sourceError = null;
  let resolvedUrl = url;
  if (isSocial && !retry.resumePlaces) {
    try {extracted = await telemetry.stage('extraction',()=>extractPublicPost(url)); resolvedUrl = extracted.webpage_url || url;}
    catch (error) {sourceError = asEngineError(error,{stage:'source',provider:extractDomain(url)}); await recordStageFailure(jobId,{stage:'source',kind:sourceError.code,message:sourceError.message});}
  }
  if (extracted?.subtitle_failures?.length) {
    const diagnostic = extracted.subtitle_failures.find(f => ['access_blocked','rate_limited','dependency_timeout'].includes(f.code)) || extracted.subtitle_failures[0];
    sourceError = new EngineError(['access_blocked','rate_limited','dependency_timeout','source_unavailable','input_too_large','invalid_response'].includes(diagnostic.code) ? diagnostic.code : 'source_unavailable',
      { stage: 'subtitles', provider: provider || 'source', retryAfterSeconds: diagnostic.retryAfterSeconds });
    await recordStageFailure(jobId,{stage:'subtitles',kind:sourceError.code,message:sourceError.message});
    metrics.current()?.recordStage('source',null,{access_blocked:'blocked',rate_limited:'rate_limited',dependency_timeout:'timeout'}[sourceError.code] || 'failed');
  }
  let ogData = {title:'',description:'',image:'',url,siteName:extractDomain(url)};
  if (extracted) ogData = {...ogData,title:extracted.title || '',description:extracted.description || '',image:extracted.thumbnail_url || ''};
  else if (!isSocial && !retry.resumePlaces) {
    try {ogData = await telemetry.stage('metadata',()=>fetchOGMetadata(url));}
    catch(error) {sourceError = asEngineError(error,{stage:'metadata',provider:'source'});}
  }
  if (retry.resumePlaces) ogData = {...ogData,...retry.ogData};
  // Keep app-shared text separately even when the public caption exists.
  // A URL-only share is not meaningful caption evidence.
  const shareText = String(captionText || '').replace(/https?:\/\/\S+/g,'').trim();
  ogData.shareText = shareText;
  if (shareText) ogData.description = [ogData.description,shareText].filter(Boolean).join('\n');
  if (sourceError && !ogData.description && !ogData.title && !mediaEnabled) throw sourceError;

  // Content-ID dedup (after extract, when webpage_url is canonical)
  const canonicalUrl = (extracted && extracted.webpage_url) || resolvedUrl;
  ogData.image = await persistThumbnail(ogData.image, canonicalUrl);
  const contentId = extractContentId(canonicalUrl);
  if (contentId && !retry.resumePlaces && !mediaEnabled && !retry.analysisRetry) {
    const dup = await findPinByContentId(userId, contentId);
    if (dup && !useContentIndex() && !mediaEnabled && !retry.analysisRetry) return { duplicate: dup, candidates: [], canonicalUrl, ogData };
    // An index membership proves only that a source was attached. It cannot
    // complete a multi-place post; cached AI and per-place dedup resolve the rest.
  }

  // Parse @mentions from the caption and feed them into the AI prompt so
  // thin-caption photo carousels have a chance of hitting a venue handle.
  // Account identity is evidence, never proof that a handle names a venue.
  const mentionedAccounts = parseMentionedAccounts(ogData.description || '');
  ogData.accountTags = extracted?.accountTags || [];
  ogData.subtitles = extracted?.subtitles || '';
  ogData.subtitleTracks=(extracted?.subtitle_tracks || []).map(({language,provenance})=>({language,provenance}));
  metrics.current()?.language(extracted?.subtitle_tracks?.[0]?.language?.split('-')[0] || 'unknown');
  metrics.current()?.evidence({title:!!ogData.title,caption:!!ogData.description,subtitles:!!ogData.subtitles,mentions:!!mentionedAccounts.length,hashtags:!!extracted?.hashtags?.length});
  ogData.hashtags = extracted?.hashtags || [];

  // AI extract places (multi) — text signals only
  let aiResult;
  let aiError;
  try {aiResult = retry.resumePlaces ? {places:retry.resumePlaces} : await aiExtractPlaces({
    title: ogData.title,
    description: ogData.description,
    hashtags: extracted && extracted.hashtags,
    uploader: extracted && extracted.uploader,
    subtitles: extracted && extracted.subtitles,
    subtitleTracks: ogData.subtitleTracks,
    mentionedAccounts,
    shareText,
    accountTags: extracted?.accountTags || [],
    accountTagCoverage:extracted?.accountTagCoverage || 'unavailable',
    collaborators: extracted?.collaborators || [],
  }, {scope:shareText || !isSocial ? `user:${userId}` : SERVER_PUBLIC_SCOPE,bypassCache:retry.bypassCache});
  } catch(error) {aiError = asEngineError(error,{stage:'ai',provider:'anthropic'}); aiResult = {places:[]}; await recordStageFailure(jobId,{stage:'ai',kind:aiError.code,message:aiError.message});}

  // Vision pass for photo carousels. Fires whenever we have 2+ slide
  // images, not only when text AI returned empty — "10 best bars" listicle
  // carousels name one venue in caption and more on later slides. Vision
  // failure is swallowed so text-AI candidates still land as pins.
  const textPlaces = (aiResult && Array.isArray(aiResult.places)) ? aiResult.places : [];
  let visionPlaces = [];
  let visionError;
  if (extracted && extracted.is_carousel && Array.isArray(extracted.slide_thumbnails) && extracted.slide_thumbnails.length >= 2) {
    try {
      const vres = await extractPlacesFromSlides({
        imageUrls: extracted.slide_thumbnails,
        contentId,
        caption: extracted.description || '',
        hashtags: extracted.hashtags || [],
        subtitles: extracted.subtitles || '',
      }, {scope:SERVER_PUBLIC_SCOPE,bypassCache:retry.bypassCache});
      if (vres._error) throw new EngineError('dependency_error',{stage:'vision'});
      visionPlaces = (vres.places || []).map((p) => ({
        name: p && typeof p === 'object' ? p.name : String(p || ''),
        city: p && typeof p === 'object' ? (p.location || '') : '',
        address: '',
        source: 'vision',
        requiresSelection: extracted.mediaScope === 'page',
      }));
    } catch (err) {
      visionError=asEngineError(err,{stage:'vision',provider:'source'});
      console.warn('vision extractPlacesFromSlides failed, continuing with text AI only:', err.message);
      recordStageFailure(jobId, { stage: 'vision', kind: classifyError(err), message: err.message });
      visionPlaces = [];
    }
  }



  // Merge text + vision candidates, dedup by normalized name (so
  // "Café Nowhere" and "cafe nowhere" don't double-pin).
  let allCandidates = dedupe(
    [...textPlaces, ...visionPlaces],
    (p) => `${normalizePlaceName(p.name)}|${normalizePlaceName(p.city)}|${normalizePlaceName(p.address)}`,
  );

  let mediaResult=null, deferredCandidates=[];
  const escalate=async(reason)=>{
    mediaResult=await collectVideoEvidence({url:canonicalUrl,extracted,ogData,reason,sourceError,
      retryOperations:retry.mediaRetryOperations || [],baselinePlaces:allCandidates.slice(0,40)});
    metrics.current()?.evidence({audio:['complete','partial'].includes(mediaResult.coverage?.audio?.status),
      video_frames:['complete','partial'].includes(mediaResult.coverage?.visual?.status) && mediaResult.coverage?.visual?.reason!=='no_distinct_frames'});
    allCandidates=mergeCandidates(allCandidates,mediaResult.places,{contradictions:mediaResult.contradictions || [],onOverflow:places=>{deferredCandidates=places;}}).map(({evidenceRefs,observations,...candidate})=>candidate);
    const ctx=jobContext.current();
    if(ctx) {ctx.mediaCoverage=mediaResult.coverage;ctx.mediaIncomplete=mediaResult.incomplete;ctx.analysisRecovery=null;
      ctx.mediaRetryOperations=mediaResult.retryOperations;}
  };
  const eligibility=()=>mediaEligibility({features:jobContext.current()?.features,url:canonicalUrl,
    extracted,ogData,places:allCandidates,attempted:!!mediaResult,analysisRetry:retry.analysisRetry});
  const before=eligibility();
  if(before.run && !retry.resumePlaces)await escalate(before.reason);
  if(!allCandidates.length && !mediaResult) {
    if(aiError && !visionPlaces.length)throw aiError;
    if(visionError && !textPlaces.length)throw visionError;
  }
  const searches=new Map();
  const matchCandidates=async()=>{
  const candidates = [];
  const matchedIds = new Set();
  const existingMatches = [];
  // AI-extracted places that fell out of the loop WITHOUT being proven
  // already-pinned (bad query, no search results, missing details). The
  // caller may only treat "all existing" as terminal when this is zero —
  // otherwise the OG fallback still deserves a shot at the unresolved ones.
  let unresolvedCount = 0;
  const outcomes = [];
  let requiresSelection = false;
  if (allCandidates.length > 0) {
    for (const p of allCandidates) {
      await jobContext.assertActive();
      const query = [p.name, p.address, p.city].filter(Boolean).join(' ');
      if (!query || query.trim().length < 2) {unresolvedCount++;outcomes.push({...p,status:'unresolved',failure:failureOf(new EngineError('no_verified_match'))});continue;}
      let results;
      try {
        if(!searches.has(query))searches.set(query,searchGooglePlaces(query));
        results = await searches.get(query);
      }
      catch(error) {unresolvedCount++;outcomes.push({...p,name:p.name,city:p.city || '',address:p.address || '',status:'unresolved',failure:failureOf(error)});continue;}
      const match = rankPlaces(results,ogData,p);
      const top = match.place;
      if (!top) {unresolvedCount++;outcomes.push({...p,name:p.name,city:p.city || '',address:p.address || '',status:'unresolved',failure:failureOf(new EngineError('no_verified_match'))});continue;}
      if((retry.baseOutcomes || []).some(o=>o.status==='dismissed' && o.placeId===top.place_id))continue;
      if(matchedIds.has(top.place_id)) continue;
      matchedIds.add(top.place_id);
      requiresSelection = requiresSelection || match.requiresSelection;
      // Per-place placeId dedup: skip if user already has this pin
      const existing = await findPinByPlaceId(userId, top.place_id);
      if (existing && (!match.requiresSelection || (retry.baseOutcomes || []).some(o=>['saved','existing'].includes(o.status) && (o.placeId===top.place_id || o.pinId===existing.id)))) {
        // Already pinned — not a candidate, but the caller appends this
        // share as a new source on the existing pin (the old client
        // pipeline's "Already on your map — new link added" behavior).
        existingMatches.push(existing);
        outcomes.push({name:p.name,city:p.city || '',country:p.country || '',address:p.address || '',placeId:top.place_id,status:'existing',pinId:existing.id});
        continue;
      }
      let details = null;
      try {details = await candidateDetails(top.place_id);} catch(error) {await recordStageFailure(jobId,{stage:'details',kind:classifyError(error),message:failureOf(error).message});}
      // Search already supplied a verified ID, name and coordinates. Optional
      // hours/rating/details failing must not discard that valid location.
      outcomes.push({...p,name:p.name,status:'candidate',placeId:top.place_id,requiresSelection:match.requiresSelection,ranking:{score:match.score,candidates:match.ranked.map(r=>({placeId:r.top.place_id,score:r.score,...r.evidence}))}});
      const category = mapToCategory(
        unionTypes(top.types, details?.types),
        details?.primary_type || null,
      );
      const location = details?.address_components
        ? extractLocationFromComponents(details.address_components)
        : extractLocation(details?.formatted_address || top.formatted_address);
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
        confidenceScore: match.score,
        saveReason: 'enrichment',
      }));
    }
  }

  return {candidates,existingMatches,unresolvedCount,outcomes,requiresSelection};
  };
  let matches=await matchCandidates();
  const after=mediaEligibility({features:jobContext.current()?.features,url:canonicalUrl,extracted,ogData,
    places:allCandidates,matches,attempted:!!mediaResult,analysisRetry:retry.analysisRetry});
  if(after.run && !retry.resumePlaces) {await escalate(after.reason);matches=await matchCandidates();}
  const base=retry.baseOutcomes || [];
  const seen=new Set(matches.outcomes.map(o=>o.placeId || o.pinId).filter(Boolean));
  const freshDeferred=[...(retry.deferredOutcomes || []),...deferredCandidates.map(({name,city,country,address,source})=>({name,city:city || '',country:country || '',address:address || '',source:source || 'media',requiresSelection:true,status:'unresolved',failure:failureOf(new EngineError('input_too_large',{stage:'matching'}))}))];
  const prior=retainUnresolved(retry.priorUnresolvedOutcomes,[...base,...matches.outcomes,...freshDeferred]);
  const deferred=[...prior,...freshDeferred];
  if(jobContext.current())jobContext.current().outcomes=[...base.filter(o=>!seen.has(o.placeId || o.pinId)),...matches.outcomes,...deferred];
  matches.unresolvedCount+=deferred.length;
  return {duplicate:null,...matches,outcomes:[...matches.outcomes,...deferred],ogData,canonicalUrl,mediaAttempted:!!mediaResult,
    sourceError:mediaResult?.incomplete ? mediaResult.error || new EngineError('dependency_timeout',{stage:'media'}) : sourceError};
}

/** OG-first fallback pipeline (port of client processUrl) — used when AI returns no places. */
async function runOGFallback({ url, userId, captionText, ogData, skipAI=false }) {
  const title = ogData.title || '';
  const description = ogData.description || '';

  let searchQuery = '';

  const singleAI = skipAI ? '' : await aiExtractPlace({ title, description },{scope:`user:${userId}`,bypassCache:jobContext.current()?.retry?.bypassCache});
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
  let { place, score, requiresSelection } = calculateConfidence(results, ogData);

  if (place && score < 60) {
    const verification = await aiVerifyPlace(ogData, place.name, place.formatted_address, place.types, {scope:`user:${userId}`,bypassCache:jobContext.current()?.retry?.bypassCache});
    if (!verification.match && verification.betterQuery) {
      const aiResults = await searchGooglePlaces(verification.betterQuery);
      const check = calculateConfidence(aiResults, ogData);
      if (check.place) {
        place = check.place;
        score = check.score;
        requiresSelection = check.requiresSelection;
        results = aiResults;
      }
    }
  }

  if (!place || score < 40) return null;

  const existing = await findPinByPlaceId(userId, place.place_id);
  if (existing) return { duplicate: existing };

  let details = null;
  try {details = await candidateDetails(place.place_id);} catch { /* valid search result remains usable */ }
  const category = mapToCategory(
    unionTypes(place.types, details && details.types),
    (details && details.primary_type) || null,
  );
  const location = details && details.address_components
    ? extractLocationFromComponents(details.address_components)
    : extractLocation((details && details.formatted_address) || (place && place.formatted_address) || '');

  return {
    requiresSelection,
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

async function runEnrichmentInner(jobId, url, userId, captionText) {
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
    const context = jobContext.current();
    await jobContext.assertActive();
    context.retry = await getRetryContext(firestore,jobId,userId,url);
    context.outcomes=context.retry.initialOutcomes || context.retry.baseOutcomes || [];
    if(context.retry.analysisRecovery) {context.analysisRecovery=context.retry.analysisRecovery;context.mediaRetryOperations=context.retry.mediaRetryOperations || [];}
    if(context.retry.analysisRetry && !videoEligible({features:context.features,url})) {
      context.mediaIncomplete=true;context.mediaRetryOperations=context.retry.mediaRetryOperations || [];
      throw new EngineError('dependency_error',{stage:'media_disabled'});
    }
    if(videoEligible({features:context.features,url}))context.allowMultiplePlaces=true;
    const existingByUrl = context.retry.resumePlaces || context.retry.analysisRetry || useContentIndex() || videoEligible({features:context.features,url}) ? null : await findPinByUrl(userId, url);
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
          // Compatibility acknowledgement only. The committed pin trigger
          // owns canonical history and counters across every save path.
          recordPinSaved(userId, { category: pin.category, city: pin.city, country: pin.country }).catch(() => {});
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
    // First pin that actually received the link — terminal duplicate
    // verdicts point existingPinId at it so the "new link added" push opens
    // a pin that really has the new source.
    let appendedPin = null;
    for (let index=0; index<existingMatches.length; index++) {
      const match=existingMatches[index];
      let added;
      try { added = await appendSourceToExistingPin(match.id, sourceEntryFor(ai.canonicalUrl || url, ai.ogData)); }
      catch (error) {
        // Later matching pins have not received this source yet. A stopped
        // loop must not convert those unattempted attachments into saves.
        const unattempted=new Set(existingMatches.slice(index+1).map(pin=>pin.id));
        context.outcomes=(context.outcomes || []).map(outcome=>{
          if(!unattempted.has(outcome.pinId) || outcome.status!=='existing') return outcome;
          const {pinId:_unconfirmedId,...evidence}=outcome;
          return {...evidence,status:'unresolved',failure:failureOf(new EngineError('dependency_error',{stage:'save'}))};
        });
        throw error;
      }
      appendedToExisting = appendedToExisting || added;
      if (added && !appendedPin) appendedPin = match;
    }

    // Every place in the video resolved to an already-pinned place —
    // terminal duplicate. Do NOT fall through to the OG fallback: it would
    // re-run AI + Places for places we already matched, and can mis-resolve
    // to a different place. Gated on unresolvedCount so a place that merely
    // FAILED to resolve (no search results, missing details) still gets the
    // fallback's attempt below.
    if (
      ai.candidates.length === 0 &&
      existingMatches.length > 0 &&
      (ai.unresolvedCount || 0) === 0
    ) {
      await finishDuplicate(appendedPin || existingMatches[0], appendedToExisting);
      return;
    }

    if (ai.outcomes?.length) await updateJob(jobId,{outcomes:jobContext.current().outcomes,unresolvedCount:ai.unresolvedCount || 0,ogTitle:ai.ogData.title || '',ogDescription:ai.ogData.description || '',ogImage:ai.ogData.image || ''});

    if (ai.candidates.length === 1 && !ai.requiresSelection) {
      const result = await writePinTransactional(ai.candidates[0], ai.ogData);
      await recordTripSignalSaveIfNew(ai.candidates[0], result, jobId);
      if (result.alreadyExists) {
        // If the raced txn pin didn't take the source but an earlier
        // existing match did, report THAT pin — its sources really gained
        // the link this push announces.
        if (result.sourceAdded !== true && appendedPin) {
          await finishDuplicate(appendedPin, true);
        } else {
          await finishDuplicate({ id: result.pinId, placeName: ai.candidates[0].placeName }, result.sourceAdded || appendedToExisting);
        }
      } else {
        // Compatibility no-op; committed pin events own the profile.
        recordPinSaved(userId, {
          category: ai.candidates[0].category,
          city: ai.candidates[0].city,
          country: ai.candidates[0].country,
        }).catch(() => {});
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: ai.candidates[0].placeName, pinId: result.pinId });
      }
      return;
    }

    if (ai.candidates.length > 1 || (ai.candidates.length === 1 && ai.requiresSelection)) {
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
    // Media candidates have already passed grounded fusion and final matching.
    // Do not undo that decision through a weaker single-place fallback.
    const fallback = ai.mediaAttempted ? null : await runOGFallback({ url: ai.canonicalUrl || url, userId, captionText, ogData: ai.ogData, skipAI:true });
    if (fallback && fallback.duplicate) {
      const added = await appendSourceToExistingPin(
        fallback.duplicate.id,
        sourceEntryFor(ai.canonicalUrl || url, ai.ogData),
      );
      // If this pin didn't take the source but an earlier existing match
      // did, report the pin whose sources really gained the link.
      if (!added && appendedPin) {
        await finishDuplicate(appendedPin, true);
      } else {
        await finishDuplicate(fallback.duplicate, added || appendedToExisting);
      }
      return;
    }
    if (fallback?.pin && fallback.requiresSelection) {
      await updateJob(jobId,{status:'needs_selection',candidates:[fallback.pin],ogTitle:ai.ogData?.title || '',ogImage:ai.ogData?.image || '',completedAt:ts()});
      await sendPushForJob(jobId,userId,'needs_selection');return;
    }
    if (fallback && fallback.pin) {
      const result = await writePinTransactional(fallback.pin, ai.ogData);
      await recordTripSignalSaveIfNew(fallback.pin, result, jobId);
      if (result.alreadyExists) {
        if (result.sourceAdded !== true && appendedPin) {
          await finishDuplicate(appendedPin, true);
        } else {
          await finishDuplicate({ id: result.pinId, placeName: fallback.pin.placeName }, result.sourceAdded || appendedToExisting);
        }
      } else {
        // Compatibility no-op; committed pin events own the profile.
        recordPinSaved(userId, {
          category: fallback.pin.category,
          city: fallback.pin.city,
          country: fallback.pin.country,
        }).catch(() => {});
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: fallback.pin.placeName, pinId: result.pinId });
      }
      return;
    }

    // 5. Give up — unless the share already landed on an existing pin
    // during the candidate loop. Reporting 'failed' there would tell the
    // user their link was lost when it's actually attached to their pin.
    if (existingMatches.length > 0) {
      await finishDuplicate(appendedPin || existingMatches[0], appendedToExisting);
      return;
    }
    const lookupFailure = ai.outcomes?.find(o=>o.failure && !['no_verified_match','no_place_found'].includes(o.failure.code))?.failure;
    await updateJob(jobId, {
      status: 'failed',
      error: lookupFailure?.message || failureOf(ai.sourceError || new EngineError(ai.unresolvedCount ? 'no_verified_match' : 'no_place_found')).message,
      failure: lookupFailure || failureOf(ai.sourceError || new EngineError(ai.unresolvedCount ? 'no_verified_match' : 'no_place_found')),
      ogTitle: (ai.ogData && ai.ogData.title) || '',
      ogImage: (ai.ogData && ai.ogData.image) || '',
      completedAt: ts(),
    });
    await sendPushForJob(jobId, userId, 'failed');
  } catch (err) {
    if(err.code==='attempt_stopped') return;
    console.error(`runEnrichment failed for job ${jobId}:`, err);
    try {
      await updateJob(jobId, {
        status: 'failed',
        error: failureOf(err).message,
        failure: failureOf(err),
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

// User-selected candidates are saved server-side for schema-2 jobs. This
// keeps outcomes and counters authoritative and makes Retry remaining exact.
async function saveSelectedPlacesInner(jobId,userId,selectedIds) {
  const owner=randomUUID(), deadline=Date.now()+120000;
  if(!Array.isArray(selectedIds) || selectedIds.length>40 || selectedIds.some(id=>typeof id!=='string')) throw new EngineError('invalid_response',{stage:'selection'});
  const ref=firestore.collection('enrichmentJobs').doc(jobId);
  const claimed=await firestore.runTransaction(async txn=>{
    const snap=await txn.get(ref), data=snap.data();
    if(!data || data.userId!==userId) throw new EngineError('access_blocked',{stage:'selection'});
    if(data.status!=='needs_selection') return {run:false,data};
    const candidates=Array.isArray(data.candidates)?data.candidates:[];
    if(candidates.some(c=>c.userId!==userId) || selectedIds.some(id=>!candidates.some(c=>c.placeId===id))) throw new EngineError('invalid_response',{stage:'selection'});
    txn.update(ref,{status:'processing',workerOwner:owner,selectedPlaceIds:[...new Set(selectedIds)],engineDeadline:admin.firestore.Timestamp.fromMillis(deadline),updatedAt:ts()});
    return {run:true,data,candidates:candidates.filter(c=>selectedIds.includes(c.placeId))};
  });
  if(!claimed.run) return claimed.data;
  return jobContext.run({jobId,userId,leaseOwner:owner,deadline,allowMultiplePlaces:true,outcomes:[]},async()=>{
    const context=jobContext.current();
    context.analysisRecovery=claimed.data.analysisRecovery || null;
    context.mediaRetryOperations=claimed.data.mediaRetryOperations || [];
    const original=Array.isArray(claimed.data.outcomes)?claimed.data.outcomes:[];
    context.outcomes=original.filter(o=>o.status!=='candidate').concat(original.filter(o=>o.status==='candidate' && !selectedIds.includes(o.placeId)).map(o=>({...o,status:'dismissed'})));
    if(!selectedIds.length)context.analysisRecovery=null;
    const stop=startJobHeartbeat(jobId);
    try {
      for(const pin of claimed.candidates) {
        await jobContext.assertActive();
        const evidence=original.find(o=>o.placeId===pin.placeId) || {name:pin.placeName,city:pin.city || '',address:pin.formattedAddress || ''};
        try {
          const result=await writePinTransactional(pin,{});
          context.outcomes.push({...evidence,status:result.alreadyExists?'existing':'saved',pinId:result.pinId});
          await recordTripSignalSaveIfNew(pin,result,jobId);
          if(!result.alreadyExists) await recordPinSaved(userId,{category:pin.category,city:pin.city,country:pin.country}).catch(()=>{});
        } catch(error) {
          context.outcomes.push({...evidence,status:'unresolved',failure:failureOf(error,{stage:'save'})});
        }
      }
      const saved=context.outcomes.filter(o=>['saved','existing'].includes(o.status)).length;
      const unresolved=context.outcomes.some(o=>o.status==='unresolved');
      await updateJob(jobId,{status:unresolved && !saved?'failed':'complete',...(unresolved && !saved?{failure:failureOf(new EngineError('dependency_error',{stage:'save'}))}:{}),completedAt:ts()});
      return (await ref.get()).data();
    } finally {stop();}
  });
}

async function saveSelectedPlaces(jobId,userId,selectedIds) {
  return withLease('worker-active',()=>saveSelectedPlacesInner(jobId,userId,selectedIds),{slots:4,waitMs:5000,leaseSeconds:150});
}

async function runEnrichment(jobId,url,userId,captionText,options={}) {
  let features;
  try { features = executionFeatures(options.features); }
  catch (error) {
    await telemetry.failAttempt(firestore,jobId,userId,options,error,'not_started');
    throw error;
  }
  return jobContext.run({jobId,userId,...options,features},async()=>{
    telemetry.start(classifyContentProvider(url) || (isGoogleMapsUrl(url)?'google_maps':'web'),options.queueMs);
    try { return await runEnrichmentInner(jobId,url,userId,captionText); }
    finally { await telemetry.persist(firestore).catch(()=>console.warn('Private engine metrics could not be stored')); }
  });
}

module.exports = {
  runEnrichment,
  saveSelectedPlaces,
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
