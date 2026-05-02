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
        // → 409. Codex round-6 F18: a missing viewerIds is also a fail-
        // open vector — an attacker who can delete the field bypasses
        // the deny-list since `!isViewer` becomes vacuously true. The
        // role schema requires both arrays to be present and well-formed
        // for the editor decision to be safe; if either is absent or
        // malformed, fail closed.
        if (!isOwner) {
          const collabCheck = classifyStringArray(listData.collaboratorIds, callerUid);
          const viewerCheck = classifyStringArray(listData.viewerIds, callerUid);
          if (collabCheck.state !== 'authoritative' || viewerCheck.state !== 'authoritative') {
            return {
              ok: false,
              status: 409,
              error: 'List role arrays are missing or malformed — refusing to mutate; run admin reconcile',
            };
          }
          const isCollab = collabCheck.contains;
          const isViewer = viewerCheck.contains;
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
        // See classifyStringArray docstring above. Codex rounds 3/4/5.
        const pinData = pinSnap.exists ? pinSnap.data() : null;
        const listIdsCheck = classifyStringArray(pinData ? pinData.listIds : undefined, listId);

        if (listIdsCheck.state === 'malformed') {
          return {
            ok: false,
            status: 409,
            error: 'Pin listIds is malformed — refusing to mutate; run admin reconcile',
          };
        }

        const pinClaimsMembership =
          listIdsCheck.state === 'authoritative' && listIdsCheck.contains;

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
  if (Object.prototype.hasOwnProperty.call(overrides, 'category')) {
    const c = overrides.category;
    if (c === null) {
      dotPaths['overrides.category'] = admin.firestore.FieldValue.delete();
    } else if (typeof c === 'string' && VALID_CATEGORIES.has(c)) {
      dotPaths['overrides.category'] = c;
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
  return { ok: true, dotPaths };
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

        // Same role-array fail-closed as the removal endpoint
        // (round-5 F14, round-6 F18).
        if (!isOwner) {
          const collabCheck = classifyStringArray(listData.collaboratorIds, callerUid);
          const viewerCheck = classifyStringArray(listData.viewerIds, callerUid);
          if (collabCheck.state !== 'authoritative' || viewerCheck.state !== 'authoritative') {
            return { ok: false, status: 409, error: 'List role arrays are missing or malformed — refusing to mutate; run admin reconcile' };
          }
          const isCollab = collabCheck.contains;
          const isViewer = viewerCheck.contains;
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
          return {
            ok: false,
            status: 409,
            error: 'Pin listIds is missing or malformed — refusing to mutate; run admin reconcile',
          };
        }
        if (!listIdsCheck.contains) {
          return {
            ok: false,
            status: 409,
            error: 'Pin does not claim membership in this list — refusing to mutate stale member doc; run admin reconcile',
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

        // Codex round-4 F34: ensure the existing `overrides` ancestor is
        // either absent or a plain object before issuing dotted-field
        // updates like `overrides.category`. If a prior writer corrupted
        // the field to a scalar/array, Firestore's nested update fails at
        // commit time with a generic 500 instead of the controlled 409
        // reconcile signal we want.
        const existingOverrides = memberData.overrides;
        if (existingOverrides !== undefined && existingOverrides !== null) {
          if (typeof existingOverrides !== 'object' || Array.isArray(existingOverrides)) {
            return {
              ok: false,
              status: 409,
              error: 'Member doc overrides field is malformed (not a plain object) — refusing to mutate; run admin reconcile',
            };
          }
        }

        // Apply the validated dot-path patch.
        txn.update(memberRef, bodyCheck.dotPaths);
        return { ok: true };
      });

      if (!result.ok) {
        return res.status(result.status || 500).json({ error: result.error });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(`setMemberOverrides(${listId}/${pinId}) failed:`, err);
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = { router };
