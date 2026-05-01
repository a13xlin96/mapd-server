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

// Set freezeListMembershipWrites=true. Clients will refuse list-membership
// mutations once the flag propagates (Firestore listener push).
router.post('/admin/freeze-list-membership', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    await firestore
      .collection('configs')
      .doc('featureFlags')
      .set({ freezeListMembershipWrites: true }, { merge: true });
    res.json({ ok: true, freezeListMembershipWrites: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set freezeListMembershipWrites=false. Resumes client mutations.
router.post('/admin/unfreeze-list-membership', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    await firestore
      .collection('configs')
      .doc('featureFlags')
      .set({ freezeListMembershipWrites: false }, { merge: true });
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
async function runBackfill() {
  const stats = {
    pinsScanned: 0,
    pinsWithListIds: 0,
    membersWritten: 0,
    membersUnchanged: 0,
    errors: [],
  };

  // Use a snapshot iterator: for very large collections, collect() loads
  // everything into memory. Pin counts are bounded (typically thousands)
  // so a single get() is acceptable for now.
  const pinsSnap = await firestore.collection('pins').get();
  stats.pinsScanned = pinsSnap.size;

  // Build a flat list of (pinId, pinOwnerId, addedAt, order, listIds) entries.
  const entries = [];
  pinsSnap.forEach((doc) => {
    const data = doc.data();
    const listIds = Array.isArray(data.listIds) ? data.listIds : [];
    if (listIds.length === 0) return;
    stats.pinsWithListIds += 1;
    const addedAt = data.createdAt || admin.firestore.FieldValue.serverTimestamp();
    const orderMillis = typeof data.createdAt?.toMillis === 'function'
      ? data.createdAt.toMillis()
      : Date.now();
    for (const listId of listIds) {
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

  // Filter to entries that need writing: read existing member doc, skip if
  // already in the desired shape. This makes the second-pass "zero-diff"
  // assertion meaningful (we count what we actually changed, not total
  // membership rows).
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
      const sameShape = exData
        && exData.pinId === e.pinId
        && exData.pinOwnerId === e.pinOwnerId;
      if (sameShape) {
        stats.membersUnchanged += 1;
        continue;
      }
      batch.set(refs[j], e, { merge: true });
      writesInBatch += 1;
      stats.membersWritten += 1;
    }
    if (writesInBatch > 0) {
      try {
        await batch.commit();
      } catch (err) {
        stats.errors.push({ at: `batch starting index ${i}`, error: err.message });
      }
    }
  }

  return stats;
}

router.post('/admin/backfill-list-members', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    const stats = await runBackfill();
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Backfill failed:', err);
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

router.post('/admin/reconcile-pin-counts', requireAdmin, requireFirestore, async (_req, res) => {
  try {
    const stats = await runReconcilePinCounts();
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
};
