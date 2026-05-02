// Unit tests for the foreign-pin-removal endpoint:
// POST /lists/:listId/members/:pinId/remove
//
// Strategy mirrors admin.auth/admin.backfill: hand-rolled firestore mock
// with a Map-backed store and a runTransaction implementation that records
// per-op intents and applies them on commit. Auth is mocked by stubbing
// admin.auth().verifyIdToken via the firestore module's `admin` export.

const express = require('express');
const request = require('supertest');

function buildFirestoreMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = [];
  let nextEventId = 1;

  function makeListRef(id) {
    return {
      _path: `lists/${id}`,
      collection: (sub) => ({
        doc: (subId) => ({ _path: `lists/${id}/${sub}/${subId}` }),
      }),
    };
  }

  function collection(name) {
    return {
      doc: (id) => {
        if (id === undefined) {
          // events.doc() — auto-id
          return { _path: `${name}/__auto_${nextEventId++}` };
        }
        if (name === 'lists') return makeListRef(id);
        return { _path: `${name}/${id}` };
      },
    };
  }

  return {
    firestoreMock: {
      collection,
      runTransaction: async (fn) => {
        const txnOps = [];
        const txn = {
          get: async (ref) => {
            if (store.has(ref._path)) {
              return { exists: true, data: () => store.get(ref._path) };
            }
            return { exists: false, data: () => undefined };
          },
          set: (ref, data) => txnOps.push({ type: 'set', path: ref._path, data }),
          update: (ref, data) => txnOps.push({ type: 'update', path: ref._path, data }),
          delete: (ref) => txnOps.push({ type: 'delete', path: ref._path }),
        };
        const result = await fn(txn);
        // "Commit" — model Firestore atomically: validate every op's
        // precondition BEFORE mutating the store. If any update targets a
        // missing doc, throw with no partial mutation. This matches real
        // Firestore commit semantics (the previous sequential apply could
        // partially mutate before a later op threw, giving false confidence
        // on race tests). Codex round-3 F6 fix.
        //
        // Per-op semantics:
        //   - txn.update against a missing doc: precondition fails → abort
        //   - txn.set against a missing doc: creates it (matches prod)
        //   - txn.delete against a missing doc: no-op (matches prod)
        for (const op of txnOps) {
          if (op.type === 'update' && !store.has(op.path)) {
            throw new Error(
              `runTransaction: cannot update non-existent document ${op.path} (atomic abort)`,
            );
          }
        }
        for (const op of txnOps) {
          ops.push(op);
          if (op.type === 'delete') {
            store.delete(op.path);
          } else if (op.type === 'set') {
            store.set(op.path, op.data);
          } else if (op.type === 'update') {
            store.set(op.path, { ...(store.get(op.path) || {}), ...op.data });
          }
        }
        return result;
      },
    },
    ops,
    store,
  };
}

function buildApp({ seed = {}, verifyIdToken, firestoreOverride } = {}) {
  let app;
  let helpers;
  jest.isolateModules(() => {
    helpers = buildFirestoreMock(seed);
    const firestore = firestoreOverride === undefined
      ? helpers.firestoreMock
      : firestoreOverride;
    jest.doMock('../lib/firestore', () => ({
      firestore,
      admin: {
        auth: () => ({ verifyIdToken }),
        firestore: {
          FieldValue: {
            serverTimestamp: () => ({ _ts: true }),
            increment: (n) => ({ _increment: n }),
            arrayRemove: (...args) => ({ _arrayRemove: args }),
          },
        },
      },
    }));
    const { router } = require('../lib/listMembership');
    app = express();
    app.use(express.json());
    app.use(router);
  });
  return { app, ...helpers };
}

describe('POST /lists/:listId/members/:pinId/remove', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('auth middleware', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { app } = buildApp({ verifyIdToken: jest.fn() });
      const res = await request(app).post('/lists/L1/members/P1/remove');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization header/);
    });

    it('returns 401 when Authorization header lacks a Bearer prefix', async () => {
      const verifyIdToken = jest.fn();
      const { app } = buildApp({ verifyIdToken });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Token abc');
      expect(res.status).toBe(401);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('returns 401 when verifyIdToken rejects', async () => {
      const verifyIdToken = jest.fn().mockRejectedValue(new Error('expired'));
      const { app } = buildApp({ verifyIdToken });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer bad-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid ID token/);
      expect(verifyIdToken).toHaveBeenCalledWith('bad-token');
    });
  });

  describe('config gate', () => {
    it('returns 503 when firestore admin is not configured', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, firestoreOverride: null });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/Firestore admin not configured/);
    });
  });

  describe('authorization', () => {
    const ownerSeed = {
      'lists/L1': {
        ownerId: 'alice',
        collaboratorIds: ['bob', 'carol'],
        viewerIds: ['carol'],
        name: 'My List',
      },
      'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
      'lists/L1/members/P1': { pinId: 'P1' },
    };

    it('returns 403 when caller is neither owner nor in collaboratorIds', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'mallory' });
      const { app, ops } = buildApp({ verifyIdToken, seed: ownerSeed });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not the list owner or an editor/);
      expect(ops).toHaveLength(0);
    });

    it('succeeds when caller is the list owner', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: ownerSeed });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: false });
      // Member doc was deleted as part of the success path.
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
    });

    it('succeeds when caller is an editor (in collaboratorIds, not in viewerIds)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildApp({ verifyIdToken, seed: ownerSeed });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: false });
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
    });

    it('returns 403 when caller is a viewer (in collaboratorIds AND viewerIds)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({ verifyIdToken, seed: ownerSeed });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(403);
      expect(ops).toHaveLength(0);
    });

    // Codex round-5 F14 — fail-closed on malformed role arrays. The prior
    // bug: a viewer in collaboratorIds, with viewerIds corrupted to a
    // non-array, would have isCollab=true and isViewer=false → silently
    // escalated to editor and granted write authority.

    it('round-5: fails closed with 409 when viewerIds is non-array (auth-bypass closed)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: ['bob', 'carol'],
            viewerIds: 'carol', // CORRUPTED — should be array
            name: 'My List',
          },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/role arrays/);
      expect(ops).toHaveLength(0);
    });

    it('round-5: fails closed with 409 when viewerIds is null', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: ['bob', 'carol'],
            viewerIds: null,
            name: 'My List',
          },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-5: fails closed with 409 when collaboratorIds has non-string entries', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: ['carol', 42, null], // mixed-type corruption
            viewerIds: [],
            name: 'My List',
          },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-5: owner is unaffected by malformed role arrays — still succeeds', async () => {
      // Owner authority does not depend on role arrays, so corrupted
      // collaboratorIds/viewerIds must not lock the owner out of removing
      // pins from their own list.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: 'CORRUPTED',
            viewerIds: { also: 'corrupted' },
            name: 'My List',
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
    });

    it('round-5 F15: rejects oversized arrays (>5000 entries) with 409', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const huge = Array.from({ length: 5001 }, (_, i) => `u${i}`);
      huge[0] = 'carol'; // place caller in the array so includes() would otherwise pass
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: huge,
            viewerIds: [],
            name: 'My List',
          },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });
  });

  describe('migration freeze (Codex round-5 F17)', () => {
    // The endpoint must refuse during the migration-freeze window so a
    // foreign-pin removal can't race past the kill-switch and corrupt
    // the backfill's atomicity. The flag lives at /configs/featureFlags
    // and the read happens inside the same transaction as the writes,
    // so a flag flip during a Firestore retry is visible to the next
    // iteration.

    it('returns 409 when freezeListMembershipWrites=true', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'configs/featureFlags': { freezeListMembershipWrites: true },
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/frozen during migration/);
      expect(ops).toHaveLength(0);
    });

    it('proceeds when freezeListMembershipWrites=false', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'configs/featureFlags': { freezeListMembershipWrites: false },
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
    });

    it('proceeds when configs/featureFlags doc does not exist (default-to-not-frozen)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          // configs/featureFlags intentionally absent.
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
    });
  });

  describe('idempotency', () => {
    it('returns ok+alreadyGone=true and writes nothing when the member doc is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          // member doc intentionally absent
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: true });
      expect(ops).toHaveLength(0);
    });
  });

  describe('atomic mutations on success', () => {
    it('deletes the member doc, decrements pinCount, arrayRemoves listId from pin.listIds, and writes an activity event for the pin owner', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' }); // owner
      const { app, ops, store } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: false });

      // 1. Member doc deleted.
      const memberDelete = ops.find(
        (o) => o.type === 'delete' && o.path === 'lists/L1/members/P1'
      );
      expect(memberDelete).toBeDefined();
      expect(store.has('lists/L1/members/P1')).toBe(false);

      // 2. List.pinCount decremented; updatedAt stamped.
      const listUpdate = ops.find((o) => o.type === 'update' && o.path === 'lists/L1');
      expect(listUpdate).toBeDefined();
      expect(listUpdate.data.pinCount).toEqual({ _increment: -1 });
      expect(listUpdate.data.updatedAt).toEqual({ _ts: true });

      // 3. Pin.listIds arrayRemove(L1) + updatedAt.
      const pinUpdate = ops.find((o) => o.type === 'update' && o.path === 'pins/P1');
      expect(pinUpdate).toBeDefined();
      expect(pinUpdate.data.listIds).toEqual({ _arrayRemove: ['L1'] });
      expect(pinUpdate.data.updatedAt).toEqual({ _ts: true });

      // 4. Activity event written, addressed to the pin owner (not the caller).
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event).toBeDefined();
      expect(event.data.userId).toBe('bob'); // pin owner — receives the notification
      expect(event.data.removedBy).toBe('alice');
      expect(event.data.listId).toBe('L1');
      expect(event.data.listName).toBe('My List');
      expect(event.data.pinId).toBe('P1');
      expect(event.data.pinPlaceName).toBe('Cafe');
      expect(event.data.createdAt).toEqual({ _ts: true });
    });
  });

  describe('activity event suppression', () => {
    it('does NOT write an activity event when the caller IS the pin owner (no self-notify)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);

      // Member, list, and pin mutations still happen.
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(true);
      expect(ops.some((o) => o.type === 'update' && o.path === 'pins/P1')).toBe(true);
      // But no activity event.
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event).toBeUndefined();
    });
  });

  describe('pin-gone case', () => {
    // Codex round-2 fix: pin-gone is a drift-cleanup case (we can't prove
    // pinCount was ever bumped for this stale member). We delete the
    // member doc only; pinCount stays as-is and admin reconcile repairs
    // any resulting drift-high count authoritatively. No pin write or
    // activity event is possible since the pin is gone.
    it('removes the member doc only; does NOT decrement pinCount, write to pin, or emit event (reconcile-safe)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          // /pins/P1 intentionally absent
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: false });

      // Member deleted; nothing else touched.
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(false);
      expect(ops.some((o) => o.path === 'pins/P1')).toBe(false);
      expect(
        ops.some(
          (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
        )
      ).toBe(false);
    });
  });

  describe('missing list', () => {
    it('returns 404 and writes nothing when the list doc does not exist', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          // /lists/L1 intentionally absent
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/List not found/);
      expect(ops).toHaveLength(0);
    });
  });

  describe('membership-integrity trust boundary (Codex round-1 fix)', () => {
    // The endpoint authenticates the caller against the LIST, then trusts
    // the URL's pinId + member-doc existence. If a stale member doc exists
    // (e.g., backfill drift) referring to a pin whose listIds doesn't
    // include this list, a legitimate editor must NOT be able to:
    //   (a) write to the unrelated pin doc, or
    //   (b) trigger an activity event to the pin's owner.
    // Member-doc cleanup + list pinCount fixup are still correct.

    it('drift: pin.listIds does not include listId — deletes member doc only; does NOT decrement pinCount, write to pin, or emit event', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' }); // owner
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          // Pin claims to be in a DIFFERENT list — the member doc here is stale.
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L_OTHER'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyGone: false });

      // Member-doc cleanup is correct (the doc was stale).
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
      // Codex round-2: do NOT decrement pinCount in drift mode — we can't
      // prove the list ever counted this member, and a double-decrement
      // would corrupt below the true count with no idempotent recovery.
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(false);
      // Trust boundary: NO write to the unrelated pin doc.
      expect(ops.some((o) => o.path === 'pins/P1')).toBe(false);
      // Trust boundary: NO bogus activity notification to bob.
      expect(
        ops.some(
          (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
        )
      ).toBe(false);
    });

    it('drift: pin.listIds is missing — same drift behavior (no list/pin write, no event)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe' }, // listIds undefined
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(false);
      expect(ops.some((o) => o.path === 'pins/P1')).toBe(false);
      expect(
        ops.some((o) => o.data && o.data.type === 'list_member_removed_by_editor')
      ).toBe(false);
    });

    it('malformed: pin.listIds is non-array (schema corruption) — fail closed with 409, do NOT delete the member doc (Codex round-3)', async () => {
      // Round-1 treated this as drift and quietly removed the member doc.
      // Round-3 reverses that policy: with a corrupted source-of-truth we
      // cannot prove the membership is stale, so deleting it could erase
      // a real membership without notifying the pin owner. Fail closed
      // and leave reconcile to repair.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops, store } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: 'L1' }, // string, not array
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/malformed|non-array/);
      // Critical: nothing mutated.
      expect(ops).toHaveLength(0);
      expect(store.has('lists/L1/members/P1')).toBe(true);
    });

    it('malformed: pin.listIds is an object (schema corruption) — also fails closed with 409', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: { L1: true } },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('malformed: pin.listIds is null (Codex round-4) — fails closed with 409', async () => {
      // Round-3 treated null as "absent" (drift cleanup OK). Round-4
      // tightens this — null is a corruption signal indistinguishable
      // from "we never wrote listIds correctly", so we must fail closed.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops, store } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: null },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
      expect(store.has('lists/L1/members/P1')).toBe(true);
    });

    it('malformed: pin.listIds is an array with non-string entries (Codex round-4) — fails closed with 409', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1', 42] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('malformed: pin.listIds is an array with null entries (Codex round-4) — fails closed with 409', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: [null, 'L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('malformed: pin.listIds contains an empty string (Codex round-4) — fails closed with 409', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1', ''] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });
  });

  describe('event payload bounds (Codex round-3 fix)', () => {
    // listName / pinPlaceName must be bounded before going into the event
    // doc — otherwise an oversized field can blow past Firestore's 1MB
    // doc limit and abort the entire member-removal transaction. The
    // truncation cap is 256 chars (typical place/list names are <80).

    it('truncates a long listName in the activity event payload', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const longName = 'A'.repeat(600);
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: longName,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event).toBeDefined();
      expect(event.data.listName.length).toBeLessThanOrEqual(256);
      expect(event.data.listName).toBe('A'.repeat(256));
    });

    it('truncates a long pinPlaceName in the activity event payload', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const longPlace = 'B'.repeat(900);
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: longPlace, listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event).toBeDefined();
      expect(event.data.pinPlaceName.length).toBeLessThanOrEqual(256);
      expect(event.data.pinPlaceName).toBe('B'.repeat(256));
    });

    it('truncates by code points, not UTF-16 code units — astral chars at the boundary are not split into lone surrogates (Codex round-4)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      // 255 emoji + suffix → if naive .slice(0, 256) on UTF-16 units,
      // the 256th unit cuts a surrogate pair in half. Code-point-based
      // truncation keeps every grapheme intact.
      const emoji = '\u{1F600}'; // 😀 — 2 UTF-16 code units, 1 code point
      const longName = emoji.repeat(300);
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: longName,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event).toBeDefined();
      // Code-point truncation: 256 code points = 256 emoji. Code-unit
      // truncation would have cut to 256 UTF-16 units = 128 emoji.
      expect(Array.from(event.data.listName).length).toBe(256);
      // No lone surrogates anywhere in the truncated string.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(event.data.listName)).toBe(false);
    });

    it('coerces a non-string listName to empty string (defensive)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: { unexpected: 'shape' }, // upstream corruption
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_removed_by_editor'
      );
      expect(event.data.listName).toBe('');
    });
  });

  describe('input validation (Codex round-2 fix)', () => {
    // Without strict listId/pinId validation, percent-encoded slashes in
    // the URL decode into the doc-id parameter and crash the Firestore
    // SDK with a 500. Same gap covers control chars and reserved
    // `__...__` document IDs. These should all return clean 400s.

    function setupValidApp() {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      return buildApp({
        verifyIdToken,
        // Seed something so any accidental fall-through wouldn't 404.
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
    }

    it('returns 400 when listId contains a percent-encoded slash', async () => {
      const { app, ops } = setupValidApp();
      const res = await request(app)
        .post('/lists/L%2F1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid/);
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when pinId contains a percent-encoded slash', async () => {
      const { app, ops } = setupValidApp();
      const res = await request(app)
        .post('/lists/L1/members/P%2F1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when listId contains an encoded control character', async () => {
      const { app, ops } = setupValidApp();
      const res = await request(app)
        .post('/lists/L%00x/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when listId matches the reserved __pattern__ form', async () => {
      const { app, ops } = setupValidApp();
      const res = await request(app)
        .post('/lists/__internal__/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when pinId matches the reserved __pattern__ form', async () => {
      const { app, ops } = setupValidApp();
      const res = await request(app)
        .post('/lists/L1/members/__reserved__/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });
  });

  describe('transaction commit failure surfacing (mock-bounded)', () => {
    // SCOPE NOTE (Codex round-4 F12): this mock executes the transaction
    // callback exactly once and treats commit failure as fatal. Real
    // Firestore retries the callback on conflicts and only surfaces a
    // failure after exhausting retries. So this test does NOT prove
    // race-correctness under retry semantics — only that an unrecoverable
    // commit failure surfaces as a 500 with no partial mutation. True
    // race coverage belongs in an emulator-driven integration test.
    it('surfaces an unrecoverable commit failure as 500 with no partial mutation', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, store, firestoreMock, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [] },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      // Inject an unrecoverable commit failure by removing the list doc
      // between callback completion and commit. The atomic-validation
      // pass throws before any op is applied.
      const originalRun = firestoreMock.runTransaction;
      firestoreMock.runTransaction = async (fn) => {
        const wrappedFn = async (txn) => {
          const result = await fn(txn);
          store.delete('lists/L1');
          return result;
        };
        return originalRun(wrappedFn);
      };

      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
      // Atomicity: ops list is populated only after a successful apply
      // pass, so a thrown commit must leave it empty.
      expect(ops).toHaveLength(0);
      expect(store.has('lists/L1/members/P1')).toBe(true);
    });
  });
});
