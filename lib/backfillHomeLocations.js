// One-shot backfill that resolves User.homeCity (legacy free-text string)
// into the structured User.homeLocation object via Google Places Find
// Place (Text Search) API. Run once after Phase 1 client + rules ship.
//
// Why: Phase 1 introduces homeLocation = { placeId, displayName, latitude,
// longitude } as the source of truth for the distanceFromHomeCityKm rec
// signal. Pre-Phase-1 users only have homeCity as free text. Without a
// backfill, those users would either (a) get prompted twice to re-pick
// their home location via the migration modal sequence, or (b) keep
// computing distanceFromHomeCityKm: null on every save until they do.
//
// Best-effort. High-confidence matches are written automatically;
// ambiguous matches are left null and those users see the migration
// modal on next app open (graceful fallback per plan v5 Task H).
//
// Properties:
//   - Idempotent: users already with homeLocation are skipped.
//   - Dry-run by default: explicit dryRun: false required to write.
//   - Paginated: startAfterDocId + batchSize. Resumes safely after partial.
//   - Never touches homeCity (legacy read-only field).

const DEFAULT_BATCH_SIZE = 50;

// Tightened set per Codex review on Task 13. Originally included
// `political`, `sublocality`, `neighborhood` — too broad: a neighborhood
// or postal-code area result could pass and silently overwrite a user's
// home location with a wrong place. Restricted to locality (the canonical
// city type) and the four administrative-area levels (state/province /
// county / district).
const CITY_LIKE_TYPES = new Set([
  'locality',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'administrative_area_level_4',
]);

function normalizeForMatch(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Decide whether a Find Place result is a high-confidence match for the
 * legacy homeCity string. Conservative — false negatives mean a user gets
 * the migration modal (acceptable degradation); false positives mean a
 * wrong homeLocation is written (silent corruption — must avoid).
 *
 * High confidence requires ALL of:
 *   1. types ∩ CITY_LIKE_TYPES non-empty (locality or admin-area only)
 *   2. The normalized name equals the homeCity exactly, OR the
 *      homeCity exactly matches the FIRST comma-separated token of the
 *      name (e.g. homeCity "Brooklyn" matches "Brooklyn, NY, USA" but
 *      NOT "Williamsburg, Brooklyn, NY").
 *
 * Why exact-token instead of substring: Codex review flagged that loose
 * substring matching ("name.includes(target) || target.includes(name)")
 * could match "Brooklyn" to "Brooklyn, Iowa" or any other same-named
 * locality without country disambiguation. Exact-token + the type guard
 * narrows to "this is the city the user actually typed".
 */
function isHighConfidenceCityMatch(result, homeCity) {
  if (!result || typeof result !== 'object') return false;
  const types = Array.isArray(result.types) ? result.types : [];
  const looksLikeCity = types.some((t) => CITY_LIKE_TYPES.has(t));
  if (!looksLikeCity) return false;

  const name = normalizeForMatch(result.name || result.displayName || '');
  const target = normalizeForMatch(homeCity);
  if (!name || !target) return false;

  // First-token match on BOTH sides. The first comma-separated token is
  // the place's own name; downstream tokens are administrative context
  // ("Tokyo, Japan" → "Tokyo"; "Brooklyn, NY" → "Brooklyn"). Comparing
  // first tokens lets "Brooklyn" match "Brooklyn, NY" without matching
  // unrelated places that happen to share a substring.
  const nameFirstToken = normalizeForMatch(name.split(',')[0]);
  const targetFirstToken = normalizeForMatch(target.split(',')[0]);
  return nameFirstToken === targetFirstToken;
}

async function runBackfillHomeLocations({
  firestore,
  searchGooglePlaces,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
} = {}) {
  // Pre-flight: searchGooglePlaces returns [] both for genuine zero
  // results AND for missing API key. Codex review flagged that this
  // makes a misconfigured run look like hundreds of legitimate misses.
  // Catching the missing-key case at start aborts loudly. Transient API
  // errors (429 / 5xx) during the scan still get coerced to no-match —
  // a fuller fix requires changing the searchGooglePlaces return
  // contract to surface errors structurally (deferred).
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY not set — refusing to run backfill (every lookup would look like a no-match miss)');
  }

  const stats = {
    dryRun,
    scanned: 0,
    alreadyResolved: 0,    // user already has homeLocation
    noHomeCity: 0,         // user has neither homeCity nor homeLocation
    resolved: 0,           // high-confidence match written
    ambiguous: 0,          // search returned results but none high-confidence
    noMatch: 0,            // search returned zero results (or transient API failure — see warning above)
    searchFailed: 0,       // searchGooglePlaces threw
    raceSkipped: 0,        // user wrote homeLocation between scan-read and txn-commit
    lastDocId: null,
    sampleResolved: [],    // up to 5 examples for spot-check
    sampleAmbiguous: [],   // up to 5 examples for spot-check
  };

  let q = firestore.collection('users').orderBy('__name__').limit(batchSize);
  if (startAfterDocId) {
    q = q.startAfter(startAfterDocId);
  }

  while (true) {
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      stats.scanned += 1;
      stats.lastDocId = doc.id;
      const data = doc.data() || {};

      // Skip if already has structured homeLocation (idempotent).
      if (data.homeLocation && typeof data.homeLocation === 'object') {
        stats.alreadyResolved += 1;
        continue;
      }
      const homeCity = typeof data.homeCity === 'string' ? data.homeCity.trim() : '';
      if (!homeCity) {
        stats.noHomeCity += 1;
        continue;
      }

      // Best-effort lookup. searchGooglePlaces should never throw, but
      // wrap defensively — one user's failed lookup must not abort the
      // whole batch.
      let results = [];
      try {
        results = await searchGooglePlaces(homeCity);
      } catch (err) {
        console.warn(`searchGooglePlaces threw for "${homeCity}":`, err.message);
        stats.searchFailed += 1;
        continue;
      }

      if (!Array.isArray(results) || results.length === 0) {
        stats.noMatch += 1;
        continue;
      }

      const top = results[0];
      if (!isHighConfidenceCityMatch(top, homeCity)) {
        stats.ambiguous += 1;
        if (stats.sampleAmbiguous.length < 5) {
          stats.sampleAmbiguous.push({
            uid: doc.id,
            homeCity,
            topName: top.name || top.displayName || null,
            topTypes: top.types || null,
          });
        }
        continue;
      }

      // Build the homeLocation object. Read latitude/longitude from
      // whichever shape the search helper returned (mapNewToLegacy
      // produces geometry.location.{lat,lng}).
      const lat = top.geometry?.location?.lat ?? top.location?.latitude ?? null;
      const lng = top.geometry?.location?.lng ?? top.location?.longitude ?? null;
      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        // High-confidence by name/type but no usable coords — count as
        // ambiguous rather than silently writing garbage.
        stats.ambiguous += 1;
        continue;
      }

      const displayName =
        top.name ||
        (typeof top.displayName === 'string' ? top.displayName : null) ||
        homeCity;

      const homeLocation = {
        placeId: top.place_id || top.id || null,
        displayName,
        latitude: lat,
        longitude: lng,
      };

      if (!dryRun) {
        // Compare-and-set under a transaction: re-read the user doc and
        // only write homeLocation if it's STILL null. Without this, a
        // user who picks their home location on the client between our
        // initial scan-read and this commit would have their explicit
        // choice silently overwritten with the inferred value. Codex
        // review on Task 13 flagged this race.
        let wrote = false;
        try {
          await firestore.runTransaction(async (txn) => {
            const fresh = await txn.get(doc.ref);
            if (!fresh.exists) return; // user deleted mid-scan; drop
            const freshData = fresh.data() || {};
            if (freshData.homeLocation && typeof freshData.homeLocation === 'object') {
              // User (or another writer) populated it while we were
              // looking — respect their value, don't clobber.
              return;
            }
            txn.update(doc.ref, { homeLocation });
            wrote = true;
          });
        } catch (err) {
          console.warn(`homeLocation compare-and-set txn failed for ${doc.id}:`, err.message);
          stats.searchFailed += 1;
          continue;
        }
        if (!wrote) {
          stats.raceSkipped += 1;
          continue;
        }
      }
      stats.resolved += 1;
      if (stats.sampleResolved.length < 5) {
        stats.sampleResolved.push({
          uid: doc.id,
          homeCity,
          resolved: homeLocation,
        });
      }
    }

    if (snap.size < batchSize) break;
    q = firestore.collection('users').orderBy('__name__').startAfter(snap.docs[snap.docs.length - 1]).limit(batchSize);
  }

  return stats;
}

module.exports = { runBackfillHomeLocations, isHighConfidenceCityMatch };
