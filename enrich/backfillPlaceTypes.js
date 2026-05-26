// One-shot Places API re-enrichment to repopulate `types[]` + `primaryType`
// on legacy food pins where those fields are empty/null OR contain only
// generic tokens (point_of_interest, establishment) that can't classify
// into restaurant/cafe/bar. The earlier v4 Atmosphere backfill did NOT
// write these two fields.
//
// Costs real Places API spend (~$0.017/call) — only pays for pins that
// actually need it (skip-if-classifying). Run dry-run first.
//
// Distributed lock (Codex R2): cross-process safe. Acquires a TTL'd lock
// in configs/backfillLocks before scanning so deploy-overlap or
// multi-instance scenarios can't burn duplicate API spend on the same
// pages. Stale lock (>30 min) is auto-overwritten so operator doesn't
// need to manually clear after a crash.
//
// Per-doc transactional write (Codex R2): each write re-reads the pin
// inside a txn and skips if a concurrent writer already classified it,
// preventing stale-Places-API-data from overwriting fresher state.

const { getPlaceDetails } = require('./places');
const { mapToCategory } = require('./categories');

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const SAMPLE_LIMIT = 20;
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min — recover from crashed runs.
const LOCK_HEARTBEAT_MS = 5 * 60 * 1000; // Renew lock every 5 min while alive.
// Abort the loop SAFETY_MARGIN before TTL so a heartbeat-failed run halts
// before a second operator could legitimately acquire. Fail-closed on
// lock liveness, not fail-open (Codex R4).
const LOCK_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const PLACES_CALL_TIMEOUT_MS = 20_000; // Most Places calls finish in <1s.

// Bounded wrapper around getPlaceDetails so a single hanging API call
// can't stall the loop past the lock TTL. Without this, one stuck call
// could let a second operator's run overlap ours (Codex R3 finding).
async function getPlaceDetailsWithTimeout(placeId, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      getPlaceDetails(placeId),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`getPlaceDetails timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function hasClassifyingTypeSignal(data) {
  const types = Array.isArray(data && data.types) ? data.types : [];
  const primaryType = (data && typeof data.primaryType === 'string' && data.primaryType.length > 0)
    ? data.primaryType : null;
  if (types.length === 0 && !primaryType) return false;
  return mapToCategory(types, primaryType) !== 'other';
}

async function acquireDistributedLock(firestore, jobId) {
  const lockRef = firestore.collection('configs').doc('backfillLocks');
  await firestore.runTransaction(async (txn) => {
    const snap = await txn.get(lockRef);
    const data = snap.exists ? snap.data() : {};
    const existing = data && data.placeTypes;
    if (existing) {
      const ageMs = Date.now() - (existing.startedAtMs || 0);
      if (ageMs < LOCK_STALE_MS) {
        throw new Error(
          `Another backfill-place-types run is in progress (jobId=${existing.jobId}, age=${Math.round(ageMs / 1000)}s). ` +
            'Wait for it to finish before starting another to avoid duplicate Places API spend.',
        );
      }
      // Stale lock — proceed to overwrite. Operator can investigate the
      // crashed run via the jobId in logs.
    }
    txn.set(
      lockRef,
      { placeTypes: { jobId, startedAtMs: Date.now() } },
      { merge: true },
    );
  });
}

async function releaseDistributedLock(firestore, jobId) {
  const lockRef = firestore.collection('configs').doc('backfillLocks');
  await firestore.runTransaction(async (txn) => {
    const snap = await txn.get(lockRef);
    if (!snap.exists) return;
    const data = snap.data() || {};
    const existing = data.placeTypes;
    // Ownership-aware release: only clear if it's still our lock.
    if (!existing || existing.jobId !== jobId) return;
    // Use null instead of FieldValue.delete to avoid an admin import here;
    // the acquire check treats null and missing identically.
    txn.set(lockRef, { placeTypes: null }, { merge: true });
  });
}

// Heartbeat: bumps startedAtMs on our lock so the TTL guard sees fresh
// ownership while the job is actively working. Returns an EXPLICIT outcome
// so the caller can distinguish a real renewal from an ownership-loss
// no-op (Codex R5 — the previous implementation silently masked stolen
// locks because the caller couldn't tell the two cases apart).
//   'renewed'   — we own the lock, startedAtMs was updated
//   'not-owner' — lock exists but someone else holds it
//   'missing'   — lock doc / field doesn't exist anymore
async function renewDistributedLock(firestore, jobId) {
  const lockRef = firestore.collection('configs').doc('backfillLocks');
  return firestore.runTransaction(async (txn) => {
    const snap = await txn.get(lockRef);
    if (!snap.exists) return 'missing';
    const data = snap.data() || {};
    const existing = data.placeTypes;
    if (!existing) return 'missing';
    if (existing.jobId !== jobId) return 'not-owner';
    txn.set(
      lockRef,
      { placeTypes: { jobId, startedAtMs: Date.now() } },
      { merge: true },
    );
    return 'renewed';
  });
}

async function runBackfillPlaceTypes({
  firestore,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
  placesCallTimeoutMs = PLACES_CALL_TIMEOUT_MS,
  lockStaleMs = LOCK_STALE_MS,
  lockHeartbeatMs = LOCK_HEARTBEAT_MS,
  lockSafetyMarginMs = LOCK_SAFETY_MARGIN_MS,
}) {
  if (!firestore) throw new Error('firestore is required');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(
      `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}, got: ${batchSize}`,
    );
  }

  const jobId = `place-types-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await acquireDistributedLock(firestore, jobId);

  // lockHealth: mutable container shared between heartbeat (writer) and
  // inner loop (reader). Two ways the loop aborts:
  //   - lostOwnership: renew detected the lock no longer belongs to us
  //     (mid-run theft, or lock was stolen after TTL stale)
  //   - lastSuccessfulRenewAtMs stale: Firestore errors prevented renew
  //     for long enough that we're about to TTL-expire
  const lockHealth = {
    lastSuccessfulRenewAtMs: Date.now(),
    lostOwnership: false,
  };

  const heartbeat = setInterval(() => {
    renewDistributedLock(firestore, jobId)
      .then((outcome) => {
        if (outcome === 'renewed') {
          lockHealth.lastSuccessfulRenewAtMs = Date.now();
        } else {
          // 'not-owner' or 'missing' — we don't hold the lock anymore.
          // Leave lastSuccessfulRenewAtMs stale AND set the explicit
          // signal so the loop aborts immediately rather than waiting
          // for the TTL-stale check.
          lockHealth.lostOwnership = true;
          console.warn(`backfill-place-types: lock ownership lost (${outcome}) for ${jobId}`);
        }
      })
      .catch((err) => {
        // Firestore error during renew — leave lastSuccessfulRenewAtMs
        // stale; if it stays stale past TTL margin the loop aborts.
        console.warn(`backfill-place-types: heartbeat error for ${jobId}:`, err && err.message);
      });
  }, lockHeartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await _runBackfillPlaceTypesInner({
      firestore, batchSize, startAfterDocId, dryRun, placesCallTimeoutMs,
      lockHealth, lockStaleMs, lockSafetyMarginMs,
    });
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseDistributedLock(firestore, jobId);
    } catch (err) {
      console.warn(`backfill-place-types: failed to release lock for ${jobId}:`, err && err.message);
    }
  }
}

async function _runBackfillPlaceTypesInner({
  firestore, batchSize, startAfterDocId, dryRun, placesCallTimeoutMs,
  lockHealth, lockStaleMs, lockSafetyMarginMs,
}) {
  let query = firestore
    .collection('pins')
    .where('category', '==', 'food')
    .orderBy('__name__')
    .limit(batchSize);
  if (startAfterDocId !== null && startAfterDocId !== undefined) {
    if (typeof startAfterDocId !== 'string' || startAfterDocId.length === 0) {
      throw new Error('startAfterDocId must be a non-empty string when provided');
    }
    const startRef = firestore.collection('pins').doc(startAfterDocId);
    query = query.startAfter(startRef);
  }

  const snap = await query.get();

  let processed = 0;
  let updated = 0;
  let skippedAlreadyPopulated = 0;
  let skippedNoPlaceId = 0;
  let skippedNoApiSignal = 0;
  let raced = 0;
  let lastDocId = null;
  const sample = [];
  const noApiSignalSample = [];
  const failures = [];

  let abortedReason = null;

  for (const docSnap of snap.docs) {
    // Lock-liveness check — two abort triggers:
    //   1. Renew explicitly detected ownership loss (mid-run theft).
    //   2. Renew has been failing long enough that TTL is about to expire.
    if (lockHealth.lostOwnership) {
      abortedReason = 'lock ownership lost (heartbeat detected lock is no longer held by this job)';
      break;
    }
    const sinceRenewMs = Date.now() - lockHealth.lastSuccessfulRenewAtMs;
    if (sinceRenewMs > lockStaleMs - lockSafetyMarginMs) {
      abortedReason = `lock ownership likely lost (no successful renewal in ${Math.round(sinceRenewMs / 1000)}s, TTL=${Math.round(lockStaleMs / 1000)}s)`;
      break;
    }

    processed += 1;
    lastDocId = docSnap.id;

    const data = docSnap.data() || {};

    if (hasClassifyingTypeSignal(data)) {
      skippedAlreadyPopulated += 1;
      continue;
    }
    if (!data.placeId) {
      skippedNoPlaceId += 1;
      continue;
    }

    let details;
    try {
      details = await getPlaceDetailsWithTimeout(data.placeId, placesCallTimeoutMs);
    } catch (err) {
      failures.push({
        id: docSnap.id,
        placeId: data.placeId,
        error: String((err && err.message) || err).slice(0, 200),
      });
      continue;
    }

    if (!details) {
      failures.push({ id: docSnap.id, placeId: data.placeId, error: 'no details from Places API' });
      continue;
    }

    const newTypes = Array.isArray(details.types) ? details.types : [];
    const newPrimaryType = typeof details.primary_type === 'string' ? details.primary_type : null;

    if (newTypes.length === 0 && !newPrimaryType) {
      skippedNoApiSignal += 1;
      if (noApiSignalSample.length < SAMPLE_LIMIT) {
        noApiSignalSample.push({ id: docSnap.id, placeId: data.placeId });
      }
      continue;
    }

    if (sample.length < SAMPLE_LIMIT) {
      sample.push({
        id: docSnap.id,
        placeId: data.placeId,
        types: newTypes,
        primaryType: newPrimaryType,
      });
    }

    if (dryRun) {
      updated += 1;
      continue;
    }

    // Per-doc transactional write: re-read inside txn and skip if a
    // concurrent writer already classified the pin. Prevents stale Places
    // API data from overwriting fresher state.
    try {
      const outcome = await firestore.runTransaction(async (txn) => {
        const fresh = await txn.get(docSnap.ref);
        if (!fresh.exists) return 'gone';
        const freshData = fresh.data() || {};
        if (hasClassifyingTypeSignal(freshData)) return 'already-classified';
        txn.set(
          docSnap.ref,
          {
            types: newTypes.length > 0 ? newTypes : null,
            primaryType: newPrimaryType,
          },
          { merge: true },
        );
        return 'updated';
      });
      if (outcome === 'updated') updated += 1;
      else raced += 1;
    } catch (err) {
      failures.push({
        id: docSnap.id,
        placeId: data.placeId,
        error: String((err && err.message) || err).slice(0, 200),
      });
    }
  }

  return {
    processed,
    updated,
    skippedAlreadyPopulated,
    skippedNoPlaceId,
    skippedNoApiSignal,
    raced,
    failures,
    hasMore: snap.size === batchSize,
    lastDocId,
    dryRun,
    sample,
    noApiSignalSample,
    estimatedPlacesApiCallsThisRun: updated + raced + failures.length + skippedNoApiSignal,
    abortedReason,
  };
}

module.exports = { runBackfillPlaceTypes };
