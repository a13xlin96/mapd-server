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
const { authenticateRequest } = require('./auth');

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

// Single-pass classifier for string arrays (pin.listIds, collaboratorIds,
// viewerIds). Combines four checks that previously lived in separate
// `Array.isArray() && includes()` and `.some(...)` passes:
//   - shape validation (Codex rounds 3-4: null + non-array + non-string
//     entries are all "malformed", forcing fail-closed handling at the
//     call site)
//   - bounded size (Codex round-5 F15: prevents an attacker-controlled
//     1MB doc with a giant array from amplifying transaction work)
//   - membership detection (replaces a second .includes() scan)
//
// Returns:
//   { state: 'absent', contains: false }       ← undefined input
//   { state: 'malformed' }                      ← null / non-array / oversized / mixed
//   { state: 'authoritative', contains: bool }  ← valid; contains tells truth
const STRING_ARRAY_MAX = 5000;
function classifyStringArray(value, lookFor) {
  if (value === undefined) return { state: 'absent', contains: false };
  if (value === null) return { state: 'malformed' };
  if (!Array.isArray(value)) return { state: 'malformed' };
  if (value.length > STRING_ARRAY_MAX) return { state: 'malformed' };
  let contains = false;
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string' || entry.length === 0) {
      return { state: 'malformed' };
    }
    if (lookFor !== undefined && entry === lookFor) contains = true;
  }
  return { state: 'authoritative', contains };
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

// Codex P4-8 F54: cross-user activity events were truncating canonical
// listName / pinPlaceName but not sanitizing them. The override-write
// path (sanitizeDisplayString) covers ATTACKER-supplied fields, but the
// notification surface still copies CANONICAL pin/list strings into
// /events docs that other users can read. If a list owner or pin owner
// has a hostile name (HTML brackets, bidi controls, zero-width chars),
// it leaks across users via the notification.
//
// sanitizeEventField runs the same validator and falls back to '' on
// rejection — losing the field is preferable to persisting unsafe text
// into a cross-user document. Must be called AFTER truncate to keep
// the size cap; sanitize-then-truncate would over-cut on validation
// failure.
function sanitizeEventField(value) {
  const sanitized = sanitizeDisplayString(value);
  return sanitized.ok ? sanitized.value : '';
}

function requireFirestore(req, res, next) {
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore admin not configured' });
  }
  return next();
}

// Build the joiner's collaboratorProfiles entry SERVER-SIDE from their own
// /users/{uid} doc. A client-supplied profile would be forgeable, and
// collaboratorProfiles values render directly in the Manage modal for every
// other member of the list — so they must come from a source the joiner
// cannot control.
//
// Field shape matches `CollaboratorProfile` in the mapd client
// (src/types/index.ts: { uid, firstName, photoURL: string | null }) and
// mirrors getCurrentUserProfile()'s fallback chain (src/stores/authStore.ts:
// `user.firstName || user.displayName?.split(' ')[0] || 'User'`) so a
// server-side join renders identically to the legacy client-side join path.
//
// If the /users/{uid} doc doesn't exist at all, OR exists but carries
// neither firstName nor displayName, we equally "know nothing" about the
// joiner — both collapse to the same 'User' fallback (rather than the
// missing-doc case rendering a blank name while the empty-doc case renders
// 'User'). photoURL has no equivalent placeholder, so both cases give null.
function buildJoinerProfile(uid, userSnap) {
  const u = userSnap.exists ? (userSnap.data() || {}) : {};
  const rawFirstName = typeof u.firstName === 'string' ? u.firstName : '';
  const rawDisplayName = typeof u.displayName === 'string' ? u.displayName : '';
  const firstName = rawFirstName || rawDisplayName.split(' ')[0] || 'User';
  const photoURL = typeof u.photoURL === 'string' ? u.photoURL : null;
  return { uid, firstName, photoURL };
}

// POST /lists/join { token: string, asViewer?: boolean }
// Replaces the client-side invite-token lookup (clients used to query
// `lists` directly by inviteToken): the admin SDK reads the token here so
// list documents never need to be client-readable for joins. See the S2
// list-invite-lockdown plan.
//
// Rate limiting: this is the sole server-side path that checks an invite
// token, and — while tokens are still 8-char Math.random() strings, ahead
// of the S2 rollout's crypto-random-token task — an unlimited caller could
// brute-force valid tokens, with every guess billing a Firestore query.
// index.js applies `apiLimiter` to this specific path (via
// `app.use('/lists/join', apiLimiter)`, ahead of this router's mount) even
// though router-mounted listMembership routes are otherwise out of scope
// for limiters per the S2 plan — this route is the one exception, because
// it's the only one keyed on a guessable secret rather than a listId/pinId
// the caller must already know.
router.post('/lists/join', authenticateRequest, requireFirestore, async (req, res) => {
  const { token, asViewer } = req.body || {};
  if (typeof token !== 'string' || token.length === 0 || token.length > 64) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const uid = req.authUid;

  try {
    // The indexed query is used ONLY to locate a candidate doc ref. All
    // validation and the mutation itself happen inside the transaction
    // below, which re-reads the doc by ref and re-checks every precondition
    // against that fresh read. Without this, a list deleted (or its
    // inviteToken rotated/cleared by the owner revoking the invite) in the
    // gap between this query and the write would either throw against a
    // stale ref (surfacing as a raw 500 to a user who just clicked a
    // recently-revoked invite link) or, worse, write to a doc that no
    // longer represents the list the query saw.
    const querySnap = await firestore.collection('lists')
      .where('inviteToken', '==', token)
      .limit(1)
      .get();
    if (querySnap.empty) {
      return res.status(404).json({ error: 'invalid_token' });
    }
    const listRef = querySnap.docs[0].ref;

    const result = await firestore.runTransaction(async (txn) => {
      const listSnap = await txn.get(listRef);
      // Deleted, or inviteToken no longer matches (rotated/cleared) since
      // the query above — both must look identical to "this token doesn't
      // exist" from the caller's side. A revoked invite link should 404
      // cleanly, not 500.
      if (!listSnap.exists) {
        return { status: 404, body: { error: 'invalid_token' } };
      }
      const list = listSnap.data();
      if (list.inviteToken !== token) {
        return { status: 404, body: { error: 'invalid_token' } };
      }

      if (list.ownerId === uid) {
        return { status: 409, body: { error: 'own_list' } };
      }
      if (list.deletePending === true) {
        return { status: 409, body: { error: 'list_deleting' } };
      }
      // Featured lists are clone-only (see cloneFeaturedList on the
      // client) — a user who wants their own copy clones it, rather than
      // becoming an editor of the shared original. This matters here
      // specifically because the S2 rules change makes featured lists
      // readable by ALL authenticated users (isFeatured === true is one of
      // the allowed read predicates), which means their inviteToken is now
      // world-readable too. Without this check, any signed-in user could
      // read a featured list's token off the doc and join as an editor —
      // gaining metadata-rewrite and (via Path B) token-rotation rights
      // over a list they were never invited to.
      if (list.isFeatured === true) {
        return { status: 409, body: { error: 'list_featured' } };
      }
      if (Array.isArray(list.collaboratorIds) && list.collaboratorIds.includes(uid)) {
        return {
          status: 200,
          body: { alreadyMember: true, listId: listSnap.id, listName: list.name || '' },
        };
      }

      const userSnap = await txn.get(firestore.collection('users').doc(uid));
      const profile = buildJoinerProfile(uid, userSnap);

      const updates = {
        collaboratorIds: admin.firestore.FieldValue.arrayUnion(uid),
        [`collaboratorProfiles.${uid}`]: profile,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (asViewer === true) {
        updates.viewerIds = admin.firestore.FieldValue.arrayUnion(uid);
      }
      txn.update(listRef, updates);

      return {
        status: 200,
        body: { joined: true, listId: listSnap.id, listName: list.name || '' },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`joinListByToken(${uid}) failed:`, err);
    return res.status(500).json({ error: err.message });
  }
});

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
        const flagsRef = firestore.collection('configs').doc('featureFlags');

        // Read everything in one shot. Including the feature-flag doc here
        // (rather than in middleware) means the freeze check shares the
        // transaction's snapshot — if the flag flips during a Firestore
        // retry, the next iteration sees the updated value. Codex round-5
        // F17: closes the TOCTOU window between an upfront freeze check
        // and the actual writes.
        const [flagsSnap, listSnap, pinSnap, memberSnap] = await Promise.all([
          txn.get(flagsRef),
          txn.get(listRef),
          txn.get(pinRef),
          txn.get(memberRef),
        ]);

        // Codex round-6 F19: fail-closed on missing flag doc/field. The
        // prior check `flagsSnap.exists && data.freezeListMembershipWrites
        // === true` returned false (= not frozen) for both "explicit
        // false" AND "doc/field absent" — meaning a deleted flag doc
        // would silently re-open the freeze window. Now: missing doc OR
        // non-boolean field → 409.
        if (!flagsSnap.exists) {
          return {
            ok: false,
            status: 409,
            error: 'Feature flags doc missing — admin must initialize /configs/featureFlags',
          };
        }
        const flagsData = flagsSnap.data() || {};
        if (typeof flagsData.freezeListMembershipWrites !== 'boolean') {
          return {
            ok: false,
            status: 409,
            error: 'freezeListMembershipWrites field missing or non-boolean — refusing to mutate',
          };
        }
        if (flagsData.freezeListMembershipWrites === true) {
          return {
            ok: false,
            status: 409,
            error: 'List-membership writes are frozen during migration; try again after migration completes',
          };
        }

        if (!listSnap.exists) {
          return { ok: false, status: 404, error: 'List not found' };
        }
        const listData = listSnap.data();
        const isOwner = listData.ownerId === callerUid;

        // For non-owners, derive editor/viewer status from role arrays.
        // Codex round-5 F14: malformed (null/non-array/oversized/mixed)
        // → 409.
        //
        // Codex round-6 F18 originally treated `viewerIds: undefined`
        // as a fail-open vector and required both arrays to be present.
        // F60 (round-9): relax viewerIds-absent to equivalent of `[]`.
        // collaboratorIds remains strict; both arrays still 409 on
        // malformed (null/non-array/etc.).
        //
        // Rationale for accepting absent viewerIds:
        //   - The Firestore rules layer already uses
        //     `.get('viewerIds', [])` (firestore.rules:33,43-47), so
        //     it treats absent as empty. The server check was the only
        //     layer being strict, contradicting both the rules and
        //     CLAUDE.md's documented data model
        //     (`viewerIds` is a strict subset of `collaboratorIds`;
        //     absent ⇒ everyone in collaboratorIds is an editor).
        //   - Production has legacy lists missing viewerIds (confirmed:
        //     list I1ZrDaGbeA2xZufGac8B was hand-patched 2026-05-14).
        //     Every legacy editor action was 409ing.
        //
        // The Codex F60 round-2 pushback was: "the admin SDK bypasses
        // rules, so the server can't trust the rules layer." Counter:
        //   - The rules layer enforces WRITES to the list doc, not
        //     reads. Only the list owner can mutate role arrays (incl.
        //     deleting viewerIds). A non-owner cannot induce the
        //     absent state.
        //   - For "damaged" lists where an owner deleted viewerIds:
        //     either the deletion was deliberate (owner wants everyone
        //     to be an editor — our behavior is correct) or accidental
        //     (the owner restores it). Pre-F60 these lists were stuck
        //     in a 409 loop with no operator-friendly recovery path.
        //   - The Codex F18 "attacker bypasses deny-list" scenario
        //     requires an attacker who can write to the list doc, which
        //     the rules layer prevents independently of this server.
        if (!isOwner) {
          const collabCheck = classifyStringArray(listData.collaboratorIds, callerUid);
          const viewerCheck = classifyStringArray(listData.viewerIds, callerUid);
          const collabOk = collabCheck.state === 'authoritative';
          const viewerOk = viewerCheck.state === 'authoritative' || viewerCheck.state === 'absent';
          if (!collabOk || !viewerOk) {
            return {
              ok: false,
              status: 409,
              error: 'List role arrays are missing or malformed — refusing to mutate; run admin reconcile',
            };
          }
          const isCollab = collabCheck.contains;
          // F60: treat absent viewerIds as an empty viewer set.
          const isViewer = viewerCheck.state === 'authoritative' && viewerCheck.contains;
          const isEditor = isCollab && !isViewer;
          if (!isEditor) {
            return {
              ok: false,
              status: 403,
              error: 'Caller is not the list owner or an editor',
            };
          }
        }

        if (!memberSnap.exists) {
          // Idempotent: member doc already gone. Return success without
          // mutating anything else (would otherwise drift pinCount).
          return { ok: true, alreadyGone: true };
        }

        // Trust-boundary check + schema-corruption guard for pin.listIds.
        // P4-8 F52: tighten the remove route's policy to match the
        // override route — non-authoritative pin state (missing pin,
        // missing/malformed listIds, or pin doesn't claim listId) all
        // 409. Previously some of these were treated as "drift cleanup"
        // (delete the member doc anyway). That was inconsistent with
        // the override route's fail-closed stance and risked
        // destroying a possibly-real membership when the pin's
        // source-of-truth was unreadable. Stale-member cleanup belongs
        // in the admin scrub-orphan-members path, not in this user-
        // facing remove flow.
        const pinData = pinSnap.exists ? pinSnap.data() : null;
        if (!pinSnap.exists) {
          return {
            ok: false,
            status: 409,
            error: 'Pin no longer exists — refusing to mutate stale member doc; run admin scrub-orphan-members',
          };
        }
        const listIdsCheck = classifyStringArray(pinData.listIds, listId);
        if (listIdsCheck.state !== 'authoritative') {
          // P4-8 round-2 F55: be honest about the recovery path. Scrub
          // explicitly aborts when it encounters malformed pin.listIds
          // (records `invalidPinListIds` + 500), so it cannot clear
          // this state. Operator must repair the pin doc directly
          // (Firebase Console / data export tool) before this
          // membership row can be resolved.
          return {
            ok: false,
            status: 409,
            error: 'Pin listIds is missing or malformed — manual repair required (operator must fix the pin doc before this membership can be resolved)',
          };
        }
        if (!listIdsCheck.contains) {
          // This case IS recoverable via scrub — pin authoritatively
          // says "not in this list", scrub treats the member as orphan.
          return {
            ok: false,
            status: 409,
            error: 'Pin does not claim membership in this list — refusing to mutate stale member doc; run admin scrub-orphan-members',
          };
        }
        // After this point, pin authoritatively claims membership.
        // The legacy `pinClaimsMembership` flag is now always true,
        // so all the conditional decrement / pin-update / event-write
        // branches below collapse to unconditional. Kept as a local
        // for symmetry with the prior structure.
        const pinClaimsMembership = true;

        // P4-8 F53: also validate the member doc's own invariants — same
        // guards the override route applies (round-2 F31, round-3 F33).
        // Without this, a corrupted member row could be destructively
        // deleted, list.pinCount changed against a URL pin id rather
        // than the stored member identity, and an event sent to the
        // wrong user. Refuse to mutate; require admin reconcile first.
        const ownerFromPin = pinData.userId;
        const ownerFromMember = memberSnap.data().pinOwnerId;
        const memberPinId = memberSnap.data().pinId;
        const ownerIsValidString = (v) => typeof v === 'string' && v.length > 0;
        if (memberPinId !== pinId) {
          return {
            ok: false,
            status: 409,
            error: 'Member doc pinId does not match URL pinId — refusing to mutate corrupted record; run admin reconcile',
          };
        }
        if (!ownerIsValidString(ownerFromPin) || !ownerIsValidString(ownerFromMember)) {
          return {
            ok: false,
            status: 409,
            error: 'Pin or member doc has missing/malformed owner id — refusing to mutate corrupted record; run admin reconcile',
          };
        }
        if (ownerFromMember !== ownerFromPin) {
          return {
            ok: false,
            status: 409,
            error: 'Member doc pinOwnerId does not match pin owner — refusing to mutate corrupted record; run admin reconcile',
          };
        }

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
        //
        // Codex round-7 F20: ALSO validate the current pinCount is a
        // sane positive integer before decrementing. If pinCount is
        // missing, non-numeric, or already <= 0, FieldValue.increment(-1)
        // would either create the field as -1 (on missing) or silently
        // produce a corrupted value (on non-numeric / zero), masking
        // existing drift with worse drift. Fail closed; admin reconcile
        // is the right tool to repair pinCount from authoritative state.
        if (pinClaimsMembership) {
          const currentCount = listData.pinCount;
          if (
            typeof currentCount !== 'number'
            || !Number.isInteger(currentCount)
            || currentCount <= 0
          ) {
            return {
              ok: false,
              status: 409,
              error: 'List pinCount is missing or invalid — refusing to mutate; run admin reconcile-pin-counts',
            };
          }
        }

        // 1. Delete the member doc (always — cleaning up the doc is correct
        //    in both the consistent-membership and drift-cleanup cases).
        txn.delete(memberRef);

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
              // Bounded + sanitized: round-3 F7 capped size; P4-8 F54 also
              // sanitizes against HTML/control/bidi/invisible chars in the
              // canonical names so hostile owner-supplied display text
              // doesn't leak through the cross-user notification surface.
              listName: sanitizeEventField(truncate(listData.name, EVENT_FIELD_MAX)),
              pinId,
              pinPlaceName: sanitizeEventField(truncate(pinData.placeName, EVENT_FIELD_MAX)),
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

// Phase 4 P4-7: list-scoped override endpoint. Editors and owners can edit
// how a pin appears in this list (category / placeName / formattedAddress)
// without touching the canonical pin doc. Writes go to the member doc's
// `overrides` field. Foreign pins (pin.userId !== callerUid) require this
// admin-SDK route because Firestore rules require the member-doc writer
// to be the pin owner.
//
// Request body shape:
//   {
//     overrides: {
//       category?: string,           // one of VALID_CATEGORIES, or null to delete
//       placeName?: string,          // truncated to OVERRIDE_FIELD_MAX, or null to delete
//       formattedAddress?: string,   //   "                                "
//     }
//   }
// Field present (non-null) → set. Field === null → delete. Field omitted → unchanged.

const VALID_CATEGORIES = new Set([
  'food', 'accommodation', 'attraction', 'nature',
  'shopping', 'wellness', 'entertainment', 'other',
]);
const OVERRIDE_FIELD_MAX = 256;
const ALLOWED_OVERRIDE_KEYS = new Set(['category', 'placeName', 'formattedAddress']);

// Strict "plain object" check (Codex P4-7 round-5 F36). The looser
// `typeof === 'object' && !Array.isArray` test passes Date, Firestore
// Timestamp, GeoPoint, DocumentReference, Buffer, and other typed values
// — none of which support `overrides.subfield` dotted updates without
// failing at commit. Plain object means: `Object.create(null)` OR a
// literal `{}` whose prototype is `Object.prototype`.
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

// Validate that a stored overrides object only contains well-formed
// allowlisted children (Codex P4-7 round-6 F38). Without this,
// pre-existing poisoned values (e.g. an HTML-laced placeName written
// by a prior buggy/manual writer) would survive an unrelated patch
// like `{overrides:{category:'food'}}` and remain in the persisted
// record, defeating the sanitizer's stated goal.
//
// Returns null on success or an error message on failure.
//
// `skipKeys` (Codex P4-7 round-7 F40): keys the current request is
// overwriting or deleting. These are skipped during validation so a
// caller CAN recover from a poisoned existing field by sending a clean
// replacement or a null-clear. Without this, F38's pre-patch validation
// would brick recovery — one legacy bad write would make the endpoint
// permanently 409 for that member until an out-of-band admin cleanup.
function validateStoredOverrides(stored, skipKeys) {
  for (const key of Object.keys(stored)) {
    if (skipKeys && skipKeys.has(key)) continue;
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      return `existing overrides has unsupported key "${key}"`;
    }
    const v = stored[key];
    if (v === null || v === undefined) {
      // Stored null/undefined — should never appear because clears go
      // through FieldValue.delete. Treat as corruption.
      return `existing overrides.${key} is null/undefined (should have been cleared)`;
    }
    if (key === 'category') {
      if (typeof v !== 'string' || !VALID_CATEGORIES.has(v)) {
        return `existing overrides.category is not a valid Category enum value`;
      }
    } else {
      // placeName / formattedAddress: re-run the same sanitizer used at
      // write time. Any pre-existing value that wouldn't be accepted now
      // is treated as corruption.
      const sanitized = sanitizeDisplayString(v);
      if (!sanitized.ok) {
        return `existing overrides.${key} ${sanitized.error}`;
      }
    }
  }
  return null;
}

// Reject persistence of attacker-controlled display strings that downstream
// renderers/loggers might trust as safe text (Codex P4-7 round-1 F23 +
// round-2 F30).
//
// The defense layers:
//   - Trim, then reject if the result is empty (no all-whitespace inputs).
//   - Reject ASCII/C1 control chars except space and tab.
//   - Reject angle brackets (HTML/script injection surface).
//   - Reject Unicode bidi-override codepoints (Trojan-Source spoofing).
//   - Reject Unicode FORMAT-category codepoints (`\p{Cf}`) including
//     zero-width chars (U+200B/200C/200D/2060/FEFF) and other invisible
//     formatters that survive trim() — round-2 fix: an editor could
//     otherwise persist a visually blank or invisibly-padded display
//     string that bypasses round-1's trim+control checks.
//
// Returns { ok: true, value } on success or { ok: false, error } on rejection.
// Truncation happens AFTER validation so a long-but-valid input is preserved
// up to the byte budget.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
const FORMAT_OR_BIDI_RE = /\p{Cf}/u;
function sanitizeDisplayString(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'cannot be empty or whitespace-only' };
  }
  if (CONTROL_RE.test(trimmed)) {
    return { ok: false, error: 'contains forbidden control characters' };
  }
  if (FORMAT_OR_BIDI_RE.test(trimmed)) {
    return {
      ok: false,
      error: 'contains forbidden invisible / bidi formatting characters',
    };
  }
  if (trimmed.includes('<') || trimmed.includes('>')) {
    return { ok: false, error: 'angle brackets are not permitted' };
  }
  return { ok: true, value: truncate(trimmed, OVERRIDE_FIELD_MAX) };
}

// Returns { ok: true, dotPaths: { ... } } when the body is valid, or
// { ok: false, status, error } on validation failure. The dotPaths
// payload is what gets passed to txn.update — keys are dotted Firestore
// field paths like "overrides.category", values are either the new
// value (already truncated for strings) or FieldValue.delete().
function classifyOverridesBody(body, admin) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Request body must be a JSON object' };
  }
  const overrides = body.overrides;
  if (overrides === null || overrides === undefined) {
    return { ok: false, status: 400, error: 'Missing "overrides" object' };
  }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, status: 400, error: '"overrides" must be a plain object' };
  }
  const keys = Object.keys(overrides);
  for (const key of keys) {
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported override field "${key}" — allowed: ${[...ALLOWED_OVERRIDE_KEYS].join(', ')}`,
      };
    }
  }
  const dotPaths = {};
  // Codex round-10 F46: build dotPaths AND keep parsed intent so the
  // route can compute the actual delta against the stored doc and skip
  // semantic no-ops (audit-event correctness for retries / replays).
  const intent = {}; // key → { kind: 'set', value } | { kind: 'delete' }
  if (Object.prototype.hasOwnProperty.call(overrides, 'category')) {
    const c = overrides.category;
    if (c === null) {
      dotPaths['overrides.category'] = admin.firestore.FieldValue.delete();
      intent.category = { kind: 'delete' };
    } else if (typeof c === 'string' && VALID_CATEGORIES.has(c)) {
      dotPaths['overrides.category'] = c;
      intent.category = { kind: 'set', value: c };
    } else {
      return {
        ok: false,
        status: 400,
        error: `Invalid category override "${c}" — must be one of ${[...VALID_CATEGORIES].join(', ')} or null to clear`,
      };
    }
  }
  for (const stringField of ['placeName', 'formattedAddress']) {
    if (Object.prototype.hasOwnProperty.call(overrides, stringField)) {
      const v = overrides[stringField];
      if (v === null) {
        dotPaths[`overrides.${stringField}`] = admin.firestore.FieldValue.delete();
        intent[stringField] = { kind: 'delete' };
      } else if (typeof v === 'string') {
        // Codex round-1 F23: sanitize display strings — reject blank-after-
        // trim, control chars, bidi overrides, and angle brackets. Length
        // cap (256 code points) applied after sanitization passes.
        const sanitized = sanitizeDisplayString(v);
        if (!sanitized.ok) {
          return {
            ok: false,
            status: 400,
            error: `${stringField} override ${sanitized.error}`,
          };
        }
        dotPaths[`overrides.${stringField}`] = sanitized.value;
        intent[stringField] = { kind: 'set', value: sanitized.value };
      } else {
        return {
          ok: false,
          status: 400,
          error: `${stringField} override must be a string or null`,
        };
      }
    }
  }
  if (Object.keys(dotPaths).length === 0) {
    return { ok: false, status: 400, error: 'No override fields supplied' };
  }
  return { ok: true, dotPaths, intent };
}

router.post(
  '/lists/:listId/members/:pinId/overrides',
  authenticateRequest,
  requireFirestore,
  async (req, res) => {
    const { listId, pinId } = req.params;
    const callerUid = req.authUid;

    if (!isValidDocId(listId) || !isValidDocId(pinId)) {
      return res.status(400).json({ error: 'Invalid listId or pinId' });
    }

    const bodyCheck = classifyOverridesBody(req.body, admin);
    if (!bodyCheck.ok) {
      return res.status(bodyCheck.status).json({ error: bodyCheck.error });
    }

    try {
      const result = await firestore.runTransaction(async (txn) => {
        const listRef = firestore.collection('lists').doc(listId);
        const pinRef = firestore.collection('pins').doc(pinId);
        const memberRef = listRef.collection('members').doc(pinId);
        const flagsRef = firestore.collection('configs').doc('featureFlags');

        // Codex round-1 F24: read the pin doc inside the same transaction
        // so we can apply the same drift / corruption fail-closed checks
        // the remove endpoint uses. Without this, an editor can keep
        // mutating overrides on a member doc whose pin is gone or no
        // longer claims the list — making inconsistent state easier to
        // preserve and harder to detect.
        const [flagsSnap, listSnap, pinSnap, memberSnap] = await Promise.all([
          txn.get(flagsRef),
          txn.get(listRef),
          txn.get(pinRef),
          txn.get(memberRef),
        ]);

        // Same freeze gate as the removal endpoint (round-6 F19).
        if (!flagsSnap.exists) {
          return { ok: false, status: 409, error: 'Feature flags doc missing — admin must initialize /configs/featureFlags' };
        }
        const flagsData = flagsSnap.data() || {};
        if (typeof flagsData.freezeListMembershipWrites !== 'boolean') {
          return { ok: false, status: 409, error: 'freezeListMembershipWrites field missing or non-boolean — refusing to mutate' };
        }
        if (flagsData.freezeListMembershipWrites === true) {
          return { ok: false, status: 409, error: 'List-membership writes are frozen during migration; try again after migration completes' };
        }

        if (!listSnap.exists) {
          return { ok: false, status: 404, error: 'List not found' };
        }
        const listData = listSnap.data();
        const isOwner = listData.ownerId === callerUid;

        // Same role-array check as the removal endpoint
        // (round-5 F14, round-6 F18, round-9 F60). See the remove
        // route for the full rationale.
        if (!isOwner) {
          const collabCheck = classifyStringArray(listData.collaboratorIds, callerUid);
          const viewerCheck = classifyStringArray(listData.viewerIds, callerUid);
          const collabOk = collabCheck.state === 'authoritative';
          const viewerOk = viewerCheck.state === 'authoritative' || viewerCheck.state === 'absent';
          if (!collabOk || !viewerOk) {
            return { ok: false, status: 409, error: 'List role arrays are missing or malformed — refusing to mutate; run admin reconcile' };
          }
          const isCollab = collabCheck.contains;
          // F60: treat absent viewerIds as an empty viewer set.
          const isViewer = viewerCheck.state === 'authoritative' && viewerCheck.contains;
          const isEditor = isCollab && !isViewer;
          if (!isEditor) {
            return { ok: false, status: 403, error: 'Caller is not the list owner or an editor' };
          }
        }

        if (!memberSnap.exists) {
          // Cannot override a membership that doesn't exist. Member-doc
          // creation is a separate flow (addPin / addPinsToList).
          return { ok: false, status: 404, error: 'Member doc not found — pin must be added to the list first' };
        }

        // Codex round-1 F24: pin-doc consistency check. The remove endpoint
        // already does this; the override endpoint must too, otherwise an
        // editor can persist phantom overrides on a member doc whose pin
        // is gone or no longer claims this list. Same fail-closed policy:
        // missing/malformed pin.listIds → 409 reconcile.
        if (!pinSnap.exists) {
          return {
            ok: false,
            status: 409,
            error: 'Pin no longer exists — refusing to mutate stale member doc; run admin scrub-orphan-members',
          };
        }
        const pinData = pinSnap.data();
        const listIdsCheck = classifyStringArray(pinData.listIds, listId);
        if (listIdsCheck.state !== 'authoritative') {
          // P4-8 round-3 F57: same fix as the remove route's F55 — be
          // honest about the recovery path. reconcile-pin-counts only
          // rewrites list.pinCount; scrub aborts on malformed
          // pin.listIds. Manual operator intervention is the actual
          // way to clear this state.
          return {
            ok: false,
            status: 409,
            error: 'Pin listIds is missing or malformed — manual repair required (operator must fix the pin doc before this membership can be resolved)',
          };
        }
        if (!listIdsCheck.contains) {
          // Authoritative non-membership IS recoverable via scrub
          // (treats the member as orphan since pin says "not in this
          // list"). Match the remove route's guidance for symmetry.
          return {
            ok: false,
            status: 409,
            error: 'Pin does not claim membership in this list — refusing to mutate stale member doc; run admin scrub-orphan-members',
          };
        }

        // Codex round-2 F31 + round-3 F33: validate the member doc's own
        // invariants before mutating. runBackfill() repairs deterministic
        // member fields with merge:true semantics that PRESERVE extra
        // fields like `overrides` — so an override applied to a corrupted
        // member doc would survive the later authoritative repair.
        //
        // Round-3 F33 strengthens the equality check: require both
        // pinData.userId and memberData.pinOwnerId to be non-empty
        // strings before comparing. Bare equality would let
        // `undefined === undefined` or other falsy-but-equal corruption
        // pass through. runBackfill() already treats invalid pin owners
        // as non-authoritative; mirror that policy here.
        const memberData = memberSnap.data();
        if (memberData.pinId !== pinId) {
          return {
            ok: false,
            status: 409,
            error: 'Member doc pinId does not match URL pinId — refusing to mutate corrupted record; run admin reconcile',
          };
        }
        const ownerFromPin = pinData.userId;
        const ownerFromMember = memberData.pinOwnerId;
        const ownerIsValid = (v) => typeof v === 'string' && v.length > 0;
        if (!ownerIsValid(ownerFromPin) || !ownerIsValid(ownerFromMember)) {
          return {
            ok: false,
            status: 409,
            error: 'Pin or member doc has missing/malformed owner id — refusing to mutate corrupted record; run admin reconcile',
          };
        }
        if (ownerFromMember !== ownerFromPin) {
          return {
            ok: false,
            status: 409,
            error: 'Member doc pinOwnerId does not match pin owner — refusing to mutate corrupted record; run admin reconcile',
          };
        }

        // Codex round-4 F34 + round-5 F36: ensure the existing `overrides`
        // ancestor is absent or a real plain object before issuing
        // dotted-field updates like `overrides.category`. The round-4
        // check used `typeof === 'object' && !Array.isArray`, which lets
        // Date / Timestamp / GeoPoint / DocumentReference / Buffer slip
        // through — none of them support nested-field updates and the
        // commit fails with a 500 instead of the 409 reconcile signal
        // this branch exists to produce. isPlainObject() requires the
        // prototype to be Object.prototype or null.
        const existingOverrides = memberData.overrides;
        // Codex round-8 F42: `overrides: null` is corruption, not the
        // safe absent case. Round-7 short-circuited on `null` and let
        // the dotted update proceed, where it would fail at commit and
        // turn into a 500. Only undefined (truly absent) is safe.
        if (existingOverrides !== undefined) {
          if (!isPlainObject(existingOverrides)) {
            return {
              ok: false,
              status: 409,
              error: 'Member doc overrides field is malformed (not a plain object) — refusing to mutate; run admin reconcile',
            };
          }
          // Codex round-6 F38 + round-7 F40: validate existing children
          // EXCEPT those the current request is overwriting or deleting
          // (so a corrupted field can be cleaned up via a replacement or
          // a null-clear). Build the skip set from bodyCheck.intent.
          const touchedFields = new Set(Object.keys(bodyCheck.intent));
          const childError = validateStoredOverrides(existingOverrides, touchedFields);
          if (childError) {
            return {
              ok: false,
              status: 409,
              error: `Member doc ${childError} — refusing to mutate; run admin reconcile`,
            };
          }
        }

        // Codex round-10 F46: compute the EFFECTIVE delta against the
        // current stored state. A retry that re-sends the same value, or
        // a clear that targets an already-absent field, is a semantic
        // no-op — skip the write AND the audit event so the F44 trail
        // stays truthful and pin owners don't get duplicate notifications.
        const currentOverrides = isPlainObject(existingOverrides)
          ? existingOverrides
          : {};
        const effectiveDotPaths = {};
        const changedFields = [];
        for (const [field, op] of Object.entries(bodyCheck.intent)) {
          const dotPath = `overrides.${field}`;
          if (op.kind === 'set') {
            if (currentOverrides[field] !== op.value) {
              effectiveDotPaths[dotPath] = op.value;
              changedFields.push(field);
            }
          } else { // 'delete'
            if (Object.prototype.hasOwnProperty.call(currentOverrides, field)) {
              effectiveDotPaths[dotPath] = admin.firestore.FieldValue.delete();
              changedFields.push(field);
            }
          }
        }

        if (changedFields.length === 0) {
          // Semantic no-op: every requested field already matches its
          // target state. Return success without writing or auditing.
          return { ok: true, changed: false };
        }

        // Apply only the actually-changed fields.
        txn.update(memberRef, effectiveDotPaths);

        // Codex round-9 F44 + round-10 F46: emit the audit event only
        // when something truly changed AND when the caller isn't the
        // pin owner (no self-notify).
        if (memberData.pinOwnerId !== callerUid) {
          const eventRef = firestore.collection('events').doc();
          txn.set(eventRef, {
            type: 'list_member_overridden_by_editor',
            userId: memberData.pinOwnerId,
            overriddenBy: callerUid,
            listId,
            // P4-8 F54: sanitize canonical strings before they cross the
            // user boundary (same fix applied to the remove event).
            listName: sanitizeEventField(truncate(listData.name, EVENT_FIELD_MAX)),
            pinId,
            pinPlaceName: sanitizeEventField(truncate(pinData.placeName, EVENT_FIELD_MAX)),
            changedFields,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return { ok: true, changed: true };
      });

      if (!result.ok) {
        return res.status(result.status || 500).json({ error: result.error });
      }
      res.json({ ok: true, changed: result.changed });
    } catch (err) {
      console.error(`setMemberOverrides(${listId}/${pinId}) failed:`, err);
      res.status(500).json({ error: err.message });
    }
  },
);

// GET /lists/:listId/pins — membership-checked pin read for shared and
// featured lists. S3 pins-privacy-lockdown plan: client Firestore rules
// will soon deny collection QUERIES over other users' pins (single-doc
// gets stay allowed), so the legacy shared-list fallback and
// featured-list-cloning `where('listIds','array-contains', listId)`
// queries over foreign pins can no longer run from the client. This
// endpoint is their sanctioned replacement — it checks membership /
// featured status with the admin SDK, then runs that same query
// server-side.
//
// Read-only: no transaction needed, unlike the mutating routes above.
//
// Timestamps in the response serialize as Firestore's over-the-wire JSON
// shape ({_seconds, _nanoseconds}), not native Date/ISO — the client-side
// task for this plan revives them (see fetchListPins / reviveTimestamp).
router.get('/lists/:listId/pins', authenticateRequest, requireFirestore, async (req, res) => {
  const { listId } = req.params;
  const uid = req.authUid;

  if (!isValidDocId(listId)) {
    return res.status(400).json({ error: 'Invalid listId' });
  }

  try {
    const listSnap = await firestore.collection('lists').doc(listId).get();
    if (!listSnap.exists) {
      return res.status(404).json({ error: 'list_not_found' });
    }
    const list = listSnap.data() || {};
    const isMember = list.ownerId === uid
      || (Array.isArray(list.collaboratorIds) && list.collaboratorIds.includes(uid));
    if (!isMember && list.isFeatured !== true) {
      return res.status(403).json({ error: 'not_a_member' });
    }

    const pinsSnap = await firestore.collection('pins')
      .where('listIds', 'array-contains', listId)
      .limit(500)
      .get();
    const pins = pinsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ pins });
  } catch (err) {
    console.error(`getListPins(${listId}) failed:`, err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /lists/:listId/visits — membership-checked "visited by" read.
// Replaces the client's `collectionGroup('visits')
// .where('userId','in', otherUids)` query that powered the visitedBy
// filter chips: that query's result docs carry Firestore refs
// (pins/{pinId}/visits/{uid}), and the tightened rules deny non-own
// collection-group visit queries because they let any caller enumerate
// pin IDs app-wide from the ref paths alone. This endpoint checks
// membership with the admin SDK and runs the equivalent query
// server-side.
//
// DELIBERATE DIFFERENCE from GET /lists/:listId/pins above: featured
// lists do NOT grant access here via `isFeatured === true`. /pins treats
// featured-list content as effectively public (any signed-in user can
// browse a featured list's pins, e.g. to clone it), but a visit doc is
// personal activity — "did I go here, when" — belonging to whichever
// list member logged it. A stranger browsing a featured list has no
// relationship to its editors and no business seeing who among them has
// visited what. This also matches the client: the visitedBy chips only
// render for shared (non-featured) lists, so featured-list viewers never
// need this data.
//
// Bonus privacy improvement over the old client query: results are
// scoped to THIS LIST's pins only (step 3 below). The old client query
// had no such scoping — it fetched a queried collaborator's visits
// across every pin they've ever touched, on any list they're a member
// of, shared or not.
//
// Read-only: no transaction needed.
router.get('/lists/:listId/visits', authenticateRequest, requireFirestore, async (req, res) => {
  const { listId } = req.params;
  const uid = req.authUid;

  if (!isValidDocId(listId)) {
    return res.status(400).json({ error: 'Invalid listId' });
  }

  try {
    const listSnap = await firestore.collection('lists').doc(listId).get();
    if (!listSnap.exists) {
      return res.status(404).json({ error: 'list_not_found' });
    }
    const list = listSnap.data() || {};
    const isOwner = list.ownerId === uid;
    const isCollaborator = Array.isArray(list.collaboratorIds) && list.collaboratorIds.includes(uid);
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: 'not_a_member' });
    }

    // Scope: visits by the list's members (owner + collaborators),
    // deduped. Including the requester themselves is fine/simplest — the
    // client already has the requester's own visits via a separate
    // per-user subscription, so there's no privacy reason to exclude
    // self from this set.
    const memberUids = new Set();
    if (typeof list.ownerId === 'string' && list.ownerId.length > 0) {
      memberUids.add(list.ownerId);
    }
    if (Array.isArray(list.collaboratorIds)) {
      for (const c of list.collaboratorIds) {
        if (typeof c === 'string' && c.length > 0) memberUids.add(c);
      }
    }
    const memberUidList = Array.from(memberUids);
    if (memberUidList.length === 0) {
      return res.json({ visits: [] });
    }

    // Step 1: which pins belong to this list. .select() with no field
    // args fetches only document identity (no field data) — all we need
    // out of this read is the set of pin IDs to scope step 3's filter,
    // not the pin bodies themselves. (firebase-admin ^12.7.0 supports
    // Query#select() with zero arguments; verified against the installed
    // version.)
    const pinsSnap = await firestore.collection('pins')
      .where('listIds', 'array-contains', listId)
      .select()
      .limit(500)
      .get();
    const listPinIds = new Set(pinsSnap.docs.map((d) => d.id));
    if (listPinIds.size === 0) {
      return res.json({ visits: [] });
    }

    // Step 2: visits by list members, across ALL of their pins (still
    // unscoped to this list at this point — step 3 narrows it). 'in'
    // caps at 30 values, so member uids are chunked and the chunk
    // queries run in parallel.
    const IN_CHUNK_SIZE = 30;
    const chunks = [];
    for (let i = 0; i < memberUidList.length; i += IN_CHUNK_SIZE) {
      chunks.push(memberUidList.slice(i, i + IN_CHUNK_SIZE));
    }
    const snapshots = await Promise.all(
      chunks.map((chunk) => firestore.collectionGroup('visits')
        .where('userId', 'in', chunk)
        .get()),
    );

    // Step 3: server-side filter to this list's pins only. Each visit
    // doc lives at pins/{pinId}/visits/{uid}, so ref.parent (the `visits`
    // collection) .parent (the pin doc) .id recovers the pin ID.
    //
    // FIELD MINIMIZATION: visit docs also carry `visitNote` (a free-text
    // personal note) and `verdictReason` (a reserved-for-later short
    // personal verdict string) — both are personal content the visiting
    // collaborator wrote, not activity STATE, and neither is needed by
    // the visitedBy chips or any other consumer of this endpoint, so
    // both are excluded here rather than crossing into another
    // collaborator's response. Every other field below (`visited`,
    // `wouldGoBack`, `visitedAt`, `updatedAt`) is activity state the UI
    // already surfaces elsewhere (the wouldGoBackOnly filter and the
    // merged-place visit dedup both need it), so it's fine to return.
    const visits = [];
    for (const snap of snapshots) {
      for (const doc of snap.docs) {
        const pinId = doc.ref && doc.ref.parent && doc.ref.parent.parent
          ? doc.ref.parent.parent.id
          : null;
        if (!pinId || !listPinIds.has(pinId)) continue;
        const data = doc.data() || {};
        visits.push({
          pinId,
          userId: typeof data.userId === 'string' ? data.userId : doc.id,
          visited: data.visited === true,
          wouldGoBack: typeof data.wouldGoBack === 'boolean' ? data.wouldGoBack : null,
          visitedAt: data.visitedAt !== undefined ? data.visitedAt : null,
          updatedAt: data.updatedAt !== undefined ? data.updatedAt : null,
        });
      }
    }

    return res.json({ visits });
  } catch (err) {
    console.error(`getListVisits(${listId}) failed:`, err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
