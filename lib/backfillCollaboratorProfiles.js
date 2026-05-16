// One-time backfill that converts List.collaboratorProfiles from a legacy
// CollaboratorProfile[] array shape to a UID-keyed map shape. Run once after
// the 2026-05-16 collab-hardening client + rules ship.
//
// Why the migration: Firestore rules cannot diff arrays of objects, so the
// old shape could not enforce that a self-joining caller only added their
// OWN entry — a malicious crafted write could rewrite other members'
// display names. The map shape lets rules validate
//   request.resource.data.collaboratorProfiles.diff(...).affectedKeys()
//     .hasOnly([request.auth.uid])
// which closes that hole.
//
// Properties:
//   - Idempotent: docs already in map shape are skipped.
//   - Safe under concurrent client reads: read-coercion handles both shapes,
//     so a client reading mid-backfill never sees broken data.
//   - Dry-run by default: explicit dryRun: false required to write.
//   - Paginated: startAfterDocId + batchSize. Resumes safely after partial.

const DEFAULT_BATCH_SIZE = 100;

/**
 * Convert a legacy array shape to a UID-keyed map. Drops entries without
 * a string uid (these were never valid).
 */
function convertArrayToMap(arr) {
  const map = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const uid = typeof entry.uid === 'string' ? entry.uid : null;
    if (!uid) continue;
    map[uid] = {
      uid,
      firstName: typeof entry.firstName === 'string' ? entry.firstName : 'User',
      photoURL: typeof entry.photoURL === 'string' ? entry.photoURL : null,
    };
  }
  return map;
}

async function runBackfillCollaboratorProfiles({
  firestore,
  batchSize = DEFAULT_BATCH_SIZE,
  startAfterDocId = null,
  dryRun = true,
} = {}) {
  const stats = {
    dryRun,
    scanned: 0,
    alreadyMap: 0,
    convertedFromArray: 0,
    skippedMalformed: 0,
    lastDocId: null,
  };

  let q = firestore.collection('lists').orderBy('__name__').limit(batchSize);
  if (startAfterDocId) {
    q = q.startAfter(startAfterDocId);
  }

  while (true) {
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      stats.scanned += 1;
      stats.lastDocId = doc.id;
      const data = doc.data();
      const raw = data.collaboratorProfiles;

      if (Array.isArray(raw)) {
        const map = convertArrayToMap(raw);
        if (!dryRun) {
          await doc.ref.update({ collaboratorProfiles: map });
        }
        stats.convertedFromArray += 1;
      } else if (raw && typeof raw === 'object') {
        stats.alreadyMap += 1;
      } else {
        // Null / undefined / number / string — treat as malformed; reset to {}
        if (!dryRun) {
          await doc.ref.update({ collaboratorProfiles: {} });
        }
        stats.skippedMalformed += 1;
      }
    }

    // Paginate
    if (snap.size < batchSize) break;
    q = firestore
      .collection('lists')
      .orderBy('__name__')
      .startAfter(stats.lastDocId)
      .limit(batchSize);
  }

  return stats;
}

module.exports = { runBackfillCollaboratorProfiles, convertArrayToMap };
