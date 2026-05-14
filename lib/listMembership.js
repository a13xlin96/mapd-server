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

module.exports = { router };
