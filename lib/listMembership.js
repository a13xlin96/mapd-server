// Phase 4: foreign-pin-removal flow. When an editor removes a co-collaborator's
// pin from a shared list, Firestore client rules block them from updating the
// pin doc (only the pin owner can), so the legacy /pins.listIds cache and the
// new /lists/{listId}/members member doc would diverge. This server endpoint
// uses the admin SDK to perform the four mutations atomically:
//   1. Delete /lists/{listId}/members/{pinId}.
//   2. Decrement /lists/{listId}.pinCount.
//   3. Update /pins/{pinId}.listIds via arrayRemove(listId) — admin SDK
//      bypasses the pin-owner rule, so the cache stays in sync.
//   4. Write an activity event to /events/{auto} so the pin's owner sees
//      "Alex removed your X from list Y" in their feed.
//
// Auth: caller must hold a Firebase ID token AND be list owner OR editor
// (collaboratorIds AND NOT viewerIds). Same authenticateRequest middleware
// the /enrich endpoint uses.

const express = require('express');
const { firestore, admin } = require('./firestore');

const router = express.Router();

// Reuses the authenticateRequest pattern from index.js. Defined here so this
// module is self-contained — the export pattern keeps the route mountable
// without coupling to index.js's middleware.
async function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.authUid = decoded.uid;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid ID token' });
  }
}

function requireFirestore(req, res, next) {
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore admin not configured' });
  }
  return next();
}

router.post(
  '/lists/:listId/members/:pinId/remove',
  authenticateRequest,
  requireFirestore,
  async (req, res) => {
    const { listId, pinId } = req.params;
    const callerUid = req.authUid;

    if (!listId || !pinId || typeof listId !== 'string' || typeof pinId !== 'string') {
      return res.status(400).json({ error: 'listId and pinId required' });
    }

    try {
      const result = await firestore.runTransaction(async (txn) => {
        const listRef = firestore.collection('lists').doc(listId);
        const pinRef = firestore.collection('pins').doc(pinId);
        const memberRef = listRef.collection('members').doc(pinId);

        const [listSnap, pinSnap, memberSnap] = await Promise.all([
          txn.get(listRef),
          txn.get(pinRef),
          txn.get(memberRef),
        ]);

        if (!listSnap.exists) {
          return { ok: false, status: 404, error: 'List not found' };
        }
        const listData = listSnap.data();
        const isOwner = listData.ownerId === callerUid;
        const isCollab = Array.isArray(listData.collaboratorIds)
          && listData.collaboratorIds.includes(callerUid);
        const isViewer = Array.isArray(listData.viewerIds)
          && listData.viewerIds.includes(callerUid);
        const isEditor = isCollab && !isViewer;

        if (!isOwner && !isEditor) {
          return {
            ok: false,
            status: 403,
            error: 'Caller is not the list owner or an editor',
          };
        }

        if (!memberSnap.exists) {
          // Idempotent: member doc already gone. Return success without
          // mutating anything else (would otherwise drift pinCount).
          return { ok: true, alreadyGone: true };
        }

        // 1. Delete the member doc.
        txn.delete(memberRef);

        // 2. Decrement pinCount on the list.
        txn.update(listRef, {
          pinCount: admin.firestore.FieldValue.increment(-1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // 3. Update the pin's listIds denormalized cache. Skip if pin is
        //    gone (deleted out of band) — nothing to update.
        if (pinSnap.exists) {
          txn.update(pinRef, {
            listIds: admin.firestore.FieldValue.arrayRemove(listId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // 4. Write activity event so the pin's owner sees the removal.
        //    Skip when the editor IS the pin's owner (no notification needed
        //    for self-action) and when the pin is gone (no recipient).
        if (pinSnap.exists) {
          const pinData = pinSnap.data();
          const recipient = pinData.userId;
          if (recipient && recipient !== callerUid) {
            const eventRef = firestore.collection('events').doc();
            txn.set(eventRef, {
              type: 'list_member_removed_by_editor',
              userId: recipient,
              removedBy: callerUid,
              listId,
              listName: listData.name || '',
              pinId,
              pinPlaceName: pinData.placeName || '',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        return { ok: true, alreadyGone: false };
      });

      if (!result.ok) {
        return res.status(result.status || 500).json({ error: result.error });
      }
      res.json({ ok: true, alreadyGone: result.alreadyGone });
    } catch (err) {
      console.error(`removeMember(${listId}/${pinId}) failed:`, err);
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = { router };
