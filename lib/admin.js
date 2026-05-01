// Admin endpoints for the collaborative-lists migration.
//
// These are privileged operations that bypass Firestore client rules and
// touch every pin / list / member doc in the database. They are gated by
// a shared secret (ADMIN_TOKEN) to avoid accidental invocation. The
// expected workflow:
//
//   1. POST /admin/freeze-list-membership      // stop client mutations
//   2. POST /admin/backfill-list-members       // populate /lists/.../members
//   3. POST /admin/backfill-list-members       // second pass — must be 0-diff
//   4. POST /admin/reconcile-pin-counts        // ensure list.pinCount matches
//   5. POST /admin/unfreeze-list-membership    // resume client mutations
//
// Designed to be removed (or rate-limited) once the migration is complete.

const express = require('express');
const { firestore, admin } = require('./firestore');

const router = express.Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Admin auth: shared bearer token. Refuses if ADMIN_TOKEN env var unset
// (so a deployment that didn't intend to expose admin endpoints can't be
// brute-forced with an empty token).
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin endpoints disabled (ADMIN_TOKEN not set)' });
  }
  const header = req.headers['x-admin-token'] || '';
  if (header !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  return next();
}

function requireFirestore(req, res, next) {
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore admin not configured (FIREBASE_SERVICE_ACCOUNT_JSON missing)' });
  }
  return next();
}

// Refuses unless configs/featureFlags.freezeListMembershipWrites is true.
// Migration operations (backfill / scrub / reconcile) must not run against
// live writes — without this, an operator who forgets to freeze first or
// who unfreezes mid-procedure would corrupt the migration's atomicity.
async function requireFrozen(req, res, next) {
  try {
    const snap = await firestore.collection('configs').doc('featureFlags').get();
    const frozen = snap.exists && snap.data().freezeListMembershipWrites === true;
    if (!frozen) {
      return res.status(409).json({
        error: 'Migration operations require freezeListMembershipWrites=true. Call /admin/freeze-list-membership first.',
        observedFlag: snap.exists ? snap.data() : null,
      });
    }
    return next();
  } catch (err) {
    return res.status(500).json({ error: `Failed to read feature flags: ${err.message}` });
  }
}

// Migration lock: stored as configs/featureFlags.migrationInProgress
// = { jobId, startedAt }. Lock acquire and release are both transactional
// AND ownership-aware so concurrent unfreeze / manual-clear / stale-job-
// release scenarios cannot reintroduce the live-write race the lock is
// meant to prevent.

// acquireMigrationLock checks freeze AND lock-vacancy atomically. Both
// must hold for the lock to be granted. This guarantees: between the
// freeze check passing and the job actually mutating Firestore, no other
// admin call can lift the freeze (because /admin/unfreeze itself checks
// the lock transactionally — see below).
async function acquireMigrationLock(jobId) {
  const ref = firestore.collection('configs').doc('featureFlags');
  return firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : {};
    if (data.freezeListMembershipWrites !== true) {
      throw new Error(
        'Migration operations require freezeListMembershipWrites=true. ' +
          'Call /admin/freeze-list-membership first.',
      );
    }
    if (data.migrationInProgress) {
      const existing = data.migrationInProgress;
      throw new Error(
        `Another migration job is already in progress (jobId=${existing.jobId}). ` +
          'If it has stalled, clear configs/featureFlags.migrationInProgress in the Firebase Console.',
      );
    }
    txn.set(ref, {
      migrationInProgress: {
        jobId,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    }, { merge: true });
  });
}

// Release is ownership-aware: only clears the lock if the stored jobId
// matches OURS. Without this, a stale job A's finally could delete a
// fresh job B's lock (operator manually clears A → starts B → A's
// awaited finally fires → B's lock disappears mid-scan).
async function releaseMigrationLock(jobId) {
  const ref = firestore.collection('configs').doc('featureFlags');
  return firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    const current = data.migrationInProgress;
    if (!current || current.jobId !== jobId) {
      // Not our lock — leave it alone. Most likely an operator already
      // cleared the lock manually and possibly started another job.
      return;
    }
    txn.set(ref, {
      migrationInProgress: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  });
}

async function runWithMigrationLock(jobId, fn) {
  await acquireMigrationLock(jobId);
  try {
    return await fn();
  } finally {
    await releaseMigrationLock(jobId);
  }
}

// Read current feature-flag state. Useful for the ops runbook.
router.get('/admin/feature-flags', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    const snap = await firestore.collection('configs').doc('featureFlags').get();
    res.json({
      exists: snap.exists,
      data: snap.exists ? snap.data() : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settle window between flipping the freeze flag and the backfill scan.
// Clients pick the flag up via a Firestore onSnapshot listener; in the
// worst case (slow network, client just resumed) propagation can take
// several seconds. We sleep here so callers can treat a 200 response as
// "client mutations should now be paused" — but operators must STILL
// understand this is a best-effort barrier (older app builds, fully
// offline clients, etc. can still race; Phase 4 will add rule-level
// freeze enforcement for true safety). See runbook.
const FREEZE_SETTLE_MS = process.env.FREEZE_SETTLE_MS != null
  ? Number(process.env.FREEZE_SETTLE_MS)
  : 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Set freezeListMembershipWrites=true. Clients will refuse list-membership
// mutations once the flag propagates (Firestore listener push). Sleeps a
// settle window before returning so the operator's next call (backfill /
// reconcile) sees a quiescent state.
router.post('/admin/freeze-list-membership', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    await firestore
      .collection('configs')
      .doc('featureFlags')
      .set({ freezeListMembershipWrites: true }, { merge: true });
    await sleep(FREEZE_SETTLE_MS);
    res.json({
      ok: true,
      freezeListMembershipWrites: true,
      settleMs: FREEZE_SETTLE_MS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set freezeListMembershipWrites=false. Resumes client mutations.
// Done as a transaction with the lock check so a concurrent migration
// job can't slip in between read+write: the read sees no lock, then
// a job acquires the lock, then we'd flip the freeze off mid-scan.
// Transactional read-then-write closes that race.
router.post('/admin/unfreeze-list-membership', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    const ref = firestore.collection('configs').doc('featureFlags');
    const result = await firestore.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (snap.exists && snap.data().migrationInProgress) {
        return { ok: false, migrationInProgress: snap.data().migrationInProgress };
      }
      txn.set(ref, { freezeListMembershipWrites: false }, { merge: true });
      return { ok: true };
    });
    if (!result.ok) {
      return res.status(409).json({
        error: `Cannot unfreeze: migration job is still in progress (jobId=${result.migrationInProgress.jobId}). ` +
          'Wait for it to complete, or clear configs/featureFlags.migrationInProgress in the Firebase Console if it stalled.',
        migrationInProgress: result.migrationInProgress,
      });
    }
    res.json({ ok: true, freezeListMembershipWrites: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Walk every pin in /pins. For each pin with non-empty listIds, write a
 * member doc at /lists/{listId}/members/{pinId} via set({merge: true})
 * — idempotent, so a second pass produces zero new writes if all docs
 * already exist with the same content.
 *
 * Member doc shape:
 *   pinId        — denormalized doc id (matches the wildcard)
 *   pinOwnerId   — pin.userId
 *   addedBy      — pin.userId (we don't have provenance for legacy data)
 *   addedAt      — pin.createdAt (Firestore Timestamp)
 *   order        — pin.createdAt-as-millis (stable sort by creation)
 */
// Validate a candidate listId value from legacy pin.listIds. Reject malformed
// inputs (non-strings, empty, slashes — Firestore doc IDs forbid '/') so we
// can surface them in stats instead of letting Firestore throw mid-run and
// abort the whole backfill on one bad legacy value.
function isValidListIdValue(lid) {
  return typeof lid === 'string'
    && lid.length > 0
    && lid.length <= 1500
    && !lid.includes('/');
}

function isValidUserIdValue(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
}

async function runBackfill() {
  const stats = {
    pinsScanned: 0,
    pinsWithListIds: 0,
    membersWritten: 0,
    membersUnchanged: 0,
    staleListRefs: [],     // {pinId, listId} — list doc does not exist
    invalidListRefs: [],   // {pinId, listId} — listId value malformed
    invalidPinOwners: [],  // {pinId} — pin's userId missing or malformed
    errors: [],
  };

  // Use a snapshot iterator: for very large collections, collect() loads
  // everything into memory. Pin counts are bounded (typically thousands)
  // so a single get() is acceptable for now.
  const pinsSnap = await firestore.collection('pins').get();
  stats.pinsScanned = pinsSnap.size;

  // Build a flat list of (pinId, pinOwnerId, addedAt, order, listIds) entries.
  // Order fallback when createdAt is missing must be DETERMINISTIC so a
  // second-pass run produces zero diff (Date.now() would generate a new
  // value every run). 0 is fine — undated legacy pins all sort together
  // at the top of the list.
  const entries = [];
  pinsSnap.forEach((doc) => {
    const data = doc.data();
    const listIds = Array.isArray(data.listIds) ? data.listIds : [];
    if (listIds.length === 0) return;
    stats.pinsWithListIds += 1;
    // Skip + report pins whose userId is missing or malformed. Without this,
    // batch.set() would throw mid-run after earlier batches had already
    // committed, leaving the migration in a partial state.
    if (!isValidUserIdValue(data.userId)) {
      stats.invalidPinOwners.push({ pinId: doc.id });
      return;
    }
    const addedAt = data.createdAt || admin.firestore.FieldValue.serverTimestamp();
    const orderMillis = typeof data.createdAt?.toMillis === 'function'
      ? data.createdAt.toMillis()
      : 0;
    for (const listId of listIds) {
      if (!isValidListIdValue(listId)) {
        // Bad legacy data: empty string, non-string, slash, etc. Skip the
        // entry and surface the bad reference instead of letting Firestore
        // throw mid-run.
        stats.invalidListRefs.push({ pinId: doc.id, listId });
        continue;
      }
      entries.push({
        listId,
        pinId: doc.id,
        pinOwnerId: data.userId,
        addedBy: data.userId,
        addedAt,
        order: orderMillis,
      });
    }
  });

  // Validate each unique listId before writing — stale references in
  // legacy pin.listIds (e.g. lists deleted out of band) would otherwise
  // produce orphan member docs that runReconcilePinCounts later misses
  // (it only scans existing /lists docs). Surface skipped entries in
  // stats.staleListRefs and treat any presence as a hard fail so the
  // operator notices.
  const uniqueListIds = Array.from(new Set(entries.map((e) => e.listId)));
  const validListIds = new Set();
  const LIST_VALIDATE_CHUNK = 100;
  for (let i = 0; i < uniqueListIds.length; i += LIST_VALIDATE_CHUNK) {
    const chunk = uniqueListIds.slice(i, i + LIST_VALIDATE_CHUNK);
    const refs = chunk.map((lid) => firestore.collection('lists').doc(lid));
    const snaps = await firestore.getAll(...refs);
    for (let j = 0; j < snaps.length; j += 1) {
      if (snaps[j].exists) validListIds.add(chunk[j]);
    }
  }
  const validEntries = [];
  for (const e of entries) {
    if (validListIds.has(e.listId)) {
      validEntries.push(e);
    } else {
      stats.staleListRefs.push({ pinId: e.pinId, listId: e.listId });
    }
  }
  // Replace the original entries with the filtered set so the loop below
  // only writes member docs whose parent list still exists.
  entries.length = 0;
  for (const e of validEntries) entries.push(e);

  // Filter to entries that need writing: read existing member doc, skip if
  // ALL deterministic fields already match the canonical shape. This makes
  // the second-pass zero-diff assertion meaningful — checking only pinId/
  // pinOwnerId would let stale member docs with wrong addedBy / order /
  // missing addedAt survive forever as "already correct".
  // membersWritten is incremented ONLY after a successful batch.commit() so
  // the returned stat reflects committed writes, not attempted writes.
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    const refs = chunk.map((e) =>
      firestore.collection('lists').doc(e.listId).collection('members').doc(e.pinId),
    );
    const existing = await firestore.getAll(...refs);

    const batch = firestore.batch();
    let writesInBatch = 0;
    for (let j = 0; j < chunk.length; j += 1) {
      const e = chunk[j];
      const ex = existing[j];
      const exData = ex.exists ? ex.data() : null;
      // Compare every deterministic field. addedAt is a Firestore Timestamp
      // and may not be strict-equal even when semantically the same — for
      // backfill purposes, presence is enough; we don't try to bit-compare it.
      const sameShape = exData
        && exData.pinId === e.pinId
        && exData.pinOwnerId === e.pinOwnerId
        && exData.addedBy === e.addedBy
        && exData.order === e.order
        && exData.addedAt != null;
      if (sameShape) {
        stats.membersUnchanged += 1;
        continue;
      }
      batch.set(refs[j], e, { merge: true });
      writesInBatch += 1;
    }
    if (writesInBatch > 0) {
      try {
        await batch.commit();
        stats.membersWritten += writesInBatch;
      } catch (err) {
        stats.errors.push({ at: `batch starting index ${i}`, error: err.message });
        // Don't increment membersWritten — those writes did not commit.
      }
    }
  }

  return stats;
}

router.post('/admin/backfill-list-members', requireAdmin, requireFirestore, requireFrozen, async (_req, res) => {
  try {
    const stats = await runWithMigrationLock(`backfill-${Date.now()}`, () => runBackfill());
    // Treat any per-batch error or stale-listId reference as overall failure
    // — operators must investigate before treating either as a clean run.
    // Stale refs surface legacy pin.listIds entries pointing at deleted
    // lists; we silently skip them (no orphan member doc written) but the
    // operator needs to know the source data has drift.
    if (
      stats.errors.length > 0
      || stats.staleListRefs.length > 0
      || stats.invalidListRefs.length > 0
      || stats.invalidPinOwners.length > 0
    ) {
      return res.status(500).json({ ok: false, stats });
    }
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Backfill failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reverse-direction validation: walk every existing /lists/{listId}/members
 * doc and confirm the corresponding pin's listIds still references this
 * list. Member docs without that backref are orphans (e.g. left behind
 * by partial earlier migrations, manual testing, or Phase 2 dual-write
 * bugs that have since been fixed). Without this scrub, runReconcilePinCounts
 * would happily count orphans into pinCount and Phase 4 readers would
 * surface phantom memberships.
 *
 * Returns {membersScanned, orphansDeleted, errors[]}.
 * Idempotent: re-running on a clean dataset is a zero-write no-op.
 */
async function runScrubOrphanMembers() {
  const stats = {
    membersScanned: 0,
    orphansDeleted: 0,
    invalidPinListIds: [], // {pinId} — pin exists but listIds field is malformed
    errors: [],
  };

  const listsSnap = await firestore.collection('lists').get();
  // Chunk size: stay under Firestore's 500-write batch ceiling. 480 leaves
  // headroom for safety. For a list with thousands of orphans, multiple
  // batches commit sequentially rather than one over-large batch failing.
  const SCRUB_BATCH_SIZE = 480;

  for (const listDoc of listsSnap.docs) {
    try {
      const membersSnap = await firestore
        .collection('lists')
        .doc(listDoc.id)
        .collection('members')
        .get();
      if (membersSnap.empty) continue;

      // Resolve each member's pin and check pin.listIds includes this list.
      const memberDocs = membersSnap.docs;
      stats.membersScanned += memberDocs.length;
      const pinRefs = memberDocs.map((m) => firestore.collection('pins').doc(m.id));
      const pinSnaps = await firestore.getAll(...pinRefs);

      // Identify orphans. A pin that exists but has malformed (non-array)
      // listIds is NOT a license to delete — it's source-data corruption
      // we must surface, not silently scrub away. Defer to invalidPinListIds.
      const orphanIds = [];
      let hadInvalidPin = false;
      for (let i = 0; i < memberDocs.length; i += 1) {
        const memberDoc = memberDocs[i];
        const pinSnap = pinSnaps[i];
        if (pinSnap.exists) {
          const raw = pinSnap.data()?.listIds;
          if (raw !== undefined && !Array.isArray(raw)) {
            stats.invalidPinListIds.push({ pinId: memberDoc.id });
            hadInvalidPin = true;
            continue;
          }
          const pinListIds = Array.isArray(raw) ? raw : [];
          if (!pinListIds.includes(listDoc.id)) {
            orphanIds.push(memberDoc.id);
          }
        } else {
          // Pin doc gone — this is a real orphan, safe to delete.
          orphanIds.push(memberDoc.id);
        }
      }

      // If any pin had malformed listIds, we don't delete anything for this
      // list — operator must investigate before we touch member docs whose
      // source-of-truth is unreadable.
      if (hadInvalidPin) continue;

      // Chunked commits — one list with thousands of orphans must not blow
      // through Firestore's 500-write per-batch limit.
      for (let i = 0; i < orphanIds.length; i += SCRUB_BATCH_SIZE) {
        const chunk = orphanIds.slice(i, i + SCRUB_BATCH_SIZE);
        const batch = firestore.batch();
        for (const pinId of chunk) {
          batch.delete(
            firestore.collection('lists').doc(listDoc.id).collection('members').doc(pinId),
          );
        }
        try {
          await batch.commit();
          stats.orphansDeleted += chunk.length;
        } catch (err) {
          stats.errors.push({ listId: listDoc.id, chunkStart: i, error: err.message });
        }
      }
    } catch (err) {
      stats.errors.push({ listId: listDoc.id, error: err.message });
    }
  }

  return stats;
}

router.post('/admin/scrub-orphan-members', requireAdmin, requireFirestore, requireFrozen, async (_req, res) => {
  try {
    const stats = await runWithMigrationLock(`scrub-${Date.now()}`, () => runScrubOrphanMembers());
    if (stats.errors.length > 0 || stats.invalidPinListIds.length > 0) {
      return res.status(500).json({ ok: false, stats });
    }
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Scrub failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reconcile each list's pinCount field against the actual count of its
 * /lists/{listId}/members subcollection. Idempotent.
 */
async function runReconcilePinCounts() {
  const stats = {
    listsScanned: 0,
    listsUpdated: 0,
    listsAlreadyCorrect: 0,
    errors: [],
  };

  const listsSnap = await firestore.collection('lists').get();
  stats.listsScanned = listsSnap.size;

  for (const listDoc of listsSnap.docs) {
    try {
      const countSnap = await firestore
        .collection('lists')
        .doc(listDoc.id)
        .collection('members')
        .count()
        .get();
      const actualCount = countSnap.data().count;
      const storedCount = listDoc.data().pinCount;
      if (storedCount === actualCount) {
        stats.listsAlreadyCorrect += 1;
        continue;
      }
      await firestore.collection('lists').doc(listDoc.id).update({
        pinCount: actualCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      stats.listsUpdated += 1;
    } catch (err) {
      stats.errors.push({ listId: listDoc.id, error: err.message });
    }
  }

  return stats;
}

router.post('/admin/reconcile-pin-counts', requireAdmin, requireFirestore, requireFrozen, async (_req, res) => {
  try {
    const stats = await runWithMigrationLock(`reconcile-${Date.now()}`, () => runReconcilePinCounts());
    if (stats.errors.length > 0) {
      return res.status(500).json({ ok: false, stats });
    }
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Reconcile failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  // Exported for unit testing.
  runBackfill,
  runReconcilePinCounts,
  runScrubOrphanMembers,
};
