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
        // "Commit" by applying ops to the in-memory store.
        for (const op of txnOps) {
          ops.push(op);
          if (op.type === 'delete') store.delete(op.path);
          else if (op.type === 'set') store.set(op.path, op.data);
          else if (op.type === 'update') {
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
    it('still removes the member doc and decrements pinCount, but skips pin.listIds update and activity event', async () => {
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

      // Member deleted + list pinCount decremented.
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(true);
      // No write touches the pin doc.
      expect(ops.some((o) => o.path === 'pins/P1')).toBe(false);
      // No activity event (no recipient since the pin is gone).
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
});
