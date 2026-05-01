# Collaborative-Lists Migration: Backfill Runbook

This runbook walks you through populating the new `lists/{listId}/members/{pinId}`
subcollection from the existing `pin.listIds` data. Run this once, when the
mapd app's Phase 2 dual-write code has been deployed and you're ready to flip
the read switch.

The whole sequence takes a few minutes for typical data sizes.

## Prerequisites

1. The Phase 2 mapd app build is live in production and has been running long
   enough that any in-flight writes have flushed (~5 minutes after deploy).
2. The mapd-server feat/list-members-backfill branch is merged and deployed
   to Render (https://mapd-server.onrender.com).
3. You have set the `ADMIN_TOKEN` environment variable on Render (Settings →
   Environment). Pick a long random string — you'll use it once and can rotate
   it after the migration is done.
4. `FIREBASE_SERVICE_ACCOUNT_JSON` is already set on Render (used by the
   existing `/enrich` endpoint).
5. The Firestore document `configs/featureFlags` exists with at least the
   field `freezeListMembershipWrites: false`. If it doesn't, create it via
   Firebase Console → Firestore Database → Data tab → "Start collection",
   collection ID `configs`, document ID `featureFlags`, fields:
   - `freezeListMembershipWrites` (boolean) → `false`
   - `useNewListMembership` (boolean) → `false`

## Step-by-step

### 1. Save your admin token to your shell

Replace the placeholder with the value you set on Render.

```
export ADMIN_TOKEN='paste-your-render-admin-token-here'
export SERVER='https://mapd-server.onrender.com'
```

### 2. Check the current feature-flag state

```
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/feature-flags
```

You should see `{"exists":true,"data":{"freezeListMembershipWrites":false,...}}`.
If `exists` is `false`, go back to prerequisite #5 and create the doc.

### 3. Freeze client membership writes

```
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/freeze-list-membership
```

Expected response: `{"ok":true,"freezeListMembershipWrites":true}`.

The Mapd app clients will now refuse `addPinToList` / `removePinFromList` /
`deletePin` etc. with a `ListMembershipFrozenError`. This is the expected
behavior during the brief freeze window — users will see "Lists are syncing"
errors if they try to mutate. **Don't linger here longer than necessary.**

### 4. Run the backfill — first pass

```
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/backfill-list-members
```

Expected response (numbers will vary):

```json
{
  "ok": true,
  "stats": {
    "pinsScanned": 1234,
    "pinsWithListIds": 412,
    "membersWritten": 587,
    "membersUnchanged": 0,
    "errors": []
  }
}
```

Verify:
- `errors: []` — no per-batch failures
- `membersWritten` > 0 (something was actually populated)
- `pinsScanned` looks roughly right (matches your sense of how many pins exist)

If `errors` is non-empty, **stop and investigate** before proceeding. The
error array contains per-batch error messages.

### 5. Run the backfill — second pass (idempotency check)

```
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/backfill-list-members
```

Expected response:

```json
{
  "ok": true,
  "stats": {
    "pinsScanned": 1234,
    "pinsWithListIds": 412,
    "membersWritten": 0,
    "membersUnchanged": 587,
    "errors": []
  }
}
```

The critical line: `membersWritten: 0`. If the second pass writes anything,
something is non-deterministic and you need to investigate before proceeding.

### 6. Reconcile pinCount

```
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/reconcile-pin-counts
```

Expected response:

```json
{
  "ok": true,
  "stats": {
    "listsScanned": 89,
    "listsUpdated": 12,
    "listsAlreadyCorrect": 77,
    "errors": []
  }
}
```

`listsUpdated` reflects lists where `pinCount` was wrong before this run; they're
now corrected. `listsAlreadyCorrect` is the rest.

### 7. Spot-check in Firebase Console

Pick 2-3 random lists. For each:

1. Open Firebase Console → Firestore Database → Data tab.
2. Navigate to `lists/<some-list-id>/members/`. You should see one document per
   pin in the list, with fields `pinId`, `pinOwnerId`, `addedBy`, `addedAt`,
   `order`.
3. Open the parent list doc and check `pinCount` matches the number of member
   documents you see.

If anything looks off, **don't unfreeze yet.** The state is recoverable — re-run
backfill / reconcile until counts match.

### 8. Unfreeze client membership writes

```
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $SERVER/admin/unfreeze-list-membership
```

Expected response: `{"ok":true,"freezeListMembershipWrites":false}`.

Client mutations resume. Phase 2's dual-write keeps `pin.listIds` and
`lists/{listId}/members/{pinId}` in sync going forward.

## After the migration

- The endpoints stay in the codebase but are gated by `ADMIN_TOKEN`. You can
  rotate or unset that env var to disable them entirely once you're done.
- Phase 4 will flip `useNewListMembership: true` to switch reads from
  `pin.listIds` to the new subcollection. That's a separate runbook.

## If something goes wrong

- **The freeze toast fires for users for too long:** unfreeze immediately
  (step 8). The new subcollection will be partially populated — re-running
  backfill from the top is safe (idempotent).
- **A backfill batch fails:** check the `errors` array. Usually it's a
  Firestore quota or transient network issue — wait a minute and re-run.
  The idempotent set+merge means re-runs only re-write member docs that
  failed previously.
- **pinCount drift after the migration:** run the reconcile endpoint again
  any time. It's idempotent and only updates lists where the stored count
  differs from the actual count.
