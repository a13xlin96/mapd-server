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

// Strict Firestore document-ID validation. Rejects inputs that would either
// blow up the Firestore SDK (slashes, control chars) or collide with reserved
// patterns (`__...__`). Without this, a request like
// `/lists/L%2F1/members/P1/remove` decodes to listId='L/1' inside the route
// handler and crashes into a 500 with a noisy log line. Codex round-2 fix.
function isValidDocId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 1500) return false;
  if (id.includes('/')) return false;
  if (id === '.' || id === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(id)) return false;
  if (/^__.+__$/.test(id)) return false;
  return true;
}

// Bound user-controlled string fields before they go into the activity-event
// document. Without this, an oversized listName or placeName can blow past
// Firestore's per-document size limit and abort the entire transaction —
// turning event formatting into a DoS on the actual member removal. 256
// code points covers any realistic place/list name and leaves comfortable
// headroom against the 1MB doc limit even with full unicode.
//
// Truncation is by code points (not UTF-16 code units), so an astral char
// at the boundary cannot be split into a lone surrogate that downstream
// encoding might reject. Codex round-3 (cap) + round-4 (surrogate-safety).
function truncate(value, maxLen) {
  if (typeof value !== 'string') return '';
  // Array.from yields code points (each surrogate pair is one element),
  // so .slice(0, n).join('') always produces a well-formed UTF-16 string.
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLen) return value;
  return codePoints.slice(0, maxLen).join('');
}
const EVENT_FIELD_MAX = 256;

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

    if (!isValidDocId(listId) || !isValidDocId(pinId)) {
      return res.status(400).json({ error: 'Invalid listId or pinId' });
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

        // Trust-boundary check + schema-corruption guard. Three distinct
        // cases for the pin's view of this membership:
        //
        //   1. pin missing OR pin.listIds === undefined
        //      → drift cleanup is safe (cannot prove the membership is
        //        real, but losing the stale member doc is the right call)
        //   2. pin.listIds is an array AND every element is a non-empty
        //      string → authoritative: includes(listId) tells us truth
        //   3. anything else (null, non-array, or array with non-string /
        //      empty-string entries) → FAIL CLOSED. The source of truth
        //      is unreadable; deleting the member doc could erase a real
        //      membership without notifying the pin owner. Mirrors the
        //      Phase-3 round-8 admin scrub policy. Codex round-3 (non-
        //      array) + round-4 (null + mixed arrays).
        const pinData = pinSnap.exists ? pinSnap.data() : null;
        const listIdsRaw = pinData ? pinData.listIds : undefined;

        let listIdsState; // 'absent' | 'authoritative' | 'malformed'
        if (listIdsRaw === undefined) {
          listIdsState = 'absent';
        } else if (listIdsRaw === null) {
          listIdsState = 'malformed';
        } else if (!Array.isArray(listIdsRaw)) {
          listIdsState = 'malformed';
        } else if (listIdsRaw.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
          listIdsState = 'malformed';
        } else {
          listIdsState = 'authoritative';
        }

        if (listIdsState === 'malformed') {
          return {
            ok: false,
            status: 409,
            error: 'Pin listIds is malformed — refusing to mutate; run admin reconcile',
          };
        }

        const pinClaimsMembership =
          listIdsState === 'authoritative' && listIdsRaw.includes(listId);

        // 1. Delete the member doc (always — cleaning up the doc is correct
        //    in both the consistent-membership and drift-cleanup cases).
        txn.delete(memberRef);

        // 2. Decrement pinCount ONLY when the pin actually claimed
        //    membership. In drift-cleanup mode (member doc exists but
        //    pin doesn't claim it, or pin is gone), we cannot prove the
        //    list's pinCount was ever bumped for this member — a previous
        //    partial failure or out-of-band repair may have already
        //    decremented it. Decrementing again would permanently corrupt
        //    the count below the real member-doc count, and idempotent
        //    retries (alreadyGone) couldn't undo it. Reconcile repairs
        //    drift-high counts authoritatively from member-doc counts;
        //    a drift-low count corrupted by a double-decrement is much
        //    harder to detect. Codex round-2 fix.
        if (pinClaimsMembership) {
          txn.update(listRef, {
            pinCount: admin.firestore.FieldValue.increment(-1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // 3. Update the pin's listIds denormalized cache. Skip if pin is
        //    gone OR if pin doesn't actually claim membership (drift
        //    cleanup mode — don't write to an unrelated pin doc).
        if (pinClaimsMembership) {
          txn.update(pinRef, {
            listIds: admin.firestore.FieldValue.arrayRemove(listId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // 4. Write activity event so the pin's owner sees the removal.
        //    Skip when the editor IS the pin's owner (no notification for
        //    self-action), when the pin is gone (no recipient), or when
        //    the pin never claimed membership (drift case — would notify
        //    a bystander about a removal that wasn't real in their world).
        if (pinClaimsMembership) {
          const recipient = pinData.userId;
          if (recipient && recipient !== callerUid) {
            const eventRef = firestore.collection('events').doc();
            txn.set(eventRef, {
              type: 'list_member_removed_by_editor',
              userId: recipient,
              removedBy: callerUid,
              listId,
              // Bounded to prevent oversized fields from aborting the
              // member-removal transaction (Codex round-3 F7).
              listName: truncate(listData.name, EVENT_FIELD_MAX),
              pinId,
              pinPlaceName: truncate(pinData.placeName, EVENT_FIELD_MAX),
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
