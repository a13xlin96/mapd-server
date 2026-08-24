// Unit tests for the invite-token join endpoint:
// POST /lists/join
//
// This replaces the client-side Firestore query-by-inviteToken lookup with
// a server-side admin-SDK read, so `lists` docs never need to be
// client-readable for joins (S2 list-invite-lockdown plan, Task 1).
//
// Harness mirrors tests/listMembership.test.js: a hand-rolled firestore
// mock keyed by `${collection}/${id}` path strings, with `admin` stubbed for
// verifyIdToken + FieldValue. This deliberately does NOT reuse
// tests/helpers/fakeFirestore.js — that helper resolves FieldValue
// sentinels into real merged document state, but these tests need to
// assert the raw update *payload* itself (e.g. that collaboratorIds was
// patched with an actual `arrayUnion(uid)` sentinel, not just that the
// uid ended up in the array), which only a raw-ops-recording mock exposes.
//
// The route wraps its read+validate+write in firestore.runTransaction, so
// the mock's runTransaction records ops from txn.update() the same way
// listMembership.test.js's does for its transactional routes.

const express = require('express');
const request = require('supertest');

function buildFirestoreMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = [];

  function makeRef(collectionName, id) {
    return { id, _path: `${collectionName}/${id}` };
  }

  function collectionFactory(name) {
    return {
      doc: (id) => makeRef(name, id),
      where: (field, op, value) => {
        if (op !== '==') {
          throw new Error(`firestore mock only supports '==' in where(), got "${op}"`);
        }
        return {
          limit: (n) => ({
            get: async () => {
              const docs = [];
              for (const [path, data] of store.entries()) {
                if (!path.startsWith(`${name}/`)) continue;
                const rest = path.slice(name.length + 1);
                if (rest.includes('/')) continue; // skip subcollection docs
                if (data && data[field] === value) {
                  docs.push({ id: rest, data: () => data, ref: makeRef(name, rest) });
                }
                if (docs.length >= n) break;
              }
              return { empty: docs.length === 0, docs };
            },
          }),
        };
      },
    };
  }

  async function runTransaction(fn) {
    const txnOps = [];
    const txn = {
      get: async (ref) => {
        const data = store.get(ref._path);
        return {
          exists: data !== undefined,
          id: ref.id,
          data: () => data,
        };
      },
      update: (ref, patch) => txnOps.push({ type: 'update', path: ref._path, data: patch }),
    };
    const result = await fn(txn);
    // "Commit": record ops for assertions and shallow-merge the raw patch
    // into the store (dotted keys and FieldValue sentinels stored as-is —
    // no test here depends on a second request seeing resolved state).
    for (const op of txnOps) {
      ops.push(op);
      const current = store.get(op.path) || {};
      store.set(op.path, { ...current, ...op.data });
    }
    return result;
  }

  return {
    firestoreMock: { collection: collectionFactory, runTransaction },
    ops,
    store,
  };
}

function buildApp({ seed = {}, verifyIdToken, firestoreOverride } = {}) {
  let app;
  let helpers;
  jest.isolateModules(() => {
    helpers = buildFirestoreMock(seed);
    const firestore = firestoreOverride === undefined ? helpers.firestoreMock : firestoreOverride;
    jest.doMock('../lib/firestore', () => ({
      firestore,
      admin: {
        auth: () => ({ verifyIdToken }),
        firestore: {
          FieldValue: {
            serverTimestamp: () => ({ _ts: true }),
            arrayUnion: (...args) => ({ _arrayUnion: args }),
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

function postJoin(app, body, token = 'good') {
  return request(app)
    .post('/lists/join')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

describe('POST /lists/join', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('1. returns 401 when unauthenticated (no Bearer token)', async () => {
    const { app, ops } = buildApp({ verifyIdToken: jest.fn() });
    const res = await request(app).post('/lists/join').send({ token: 'tok123' });
    expect(res.status).toBe(401);
    expect(ops).toHaveLength(0);
  });

  it('2. returns 404 { error: "invalid_token" } when no list has this inviteToken', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', inviteToken: 'someone-elses-token', collaboratorIds: [], name: 'Trip' },
      },
    });
    const res = await postJoin(app, { token: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invalid_token' });
    expect(ops).toHaveLength(0);
  });

  it('3. returns 409 { error: "own_list" } when list.ownerId === authUid', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: [], name: 'Trip' },
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'own_list' });
    expect(ops).toHaveLength(0);
  });

  it('4. returns 200 { alreadyMember: true, listId, listName } when authUid already in collaboratorIds', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: ['bob'], name: 'Trip' },
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alreadyMember: true, listId: 'L1', listName: 'Trip' });
    // Already a member — must not issue any write.
    expect(ops).toHaveLength(0);
  });

  it('5. joins as editor: collaboratorIds gains authUid, viewerIds untouched, profile built from users/{uid}, updatedAt is serverTimestamp', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': {
          ownerId: 'alice',
          inviteToken: 'tok123',
          collaboratorIds: [],
          viewerIds: [],
          name: 'Trip',
        },
        'users/bob': { firstName: 'Bob', displayName: 'Bob Smith', photoURL: 'https://cdn.example/bob.jpg' },
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true, listId: 'L1', listName: 'Trip' });

    const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1');
    expect(update).toBeDefined();
    expect(update.data.collaboratorIds).toEqual({ _arrayUnion: ['bob'] });
    expect(update.data['collaboratorProfiles.bob']).toEqual({
      uid: 'bob',
      firstName: 'Bob',
      photoURL: 'https://cdn.example/bob.jpg',
    });
    expect(update.data.updatedAt).toEqual({ _ts: true });
    // Not joining as viewer — viewerIds must be absent from the patch.
    expect(update.data.viewerIds).toBeUndefined();
  });

  it('5b. falls back to displayName-derived first name and null photo when users/{uid} lacks firstName/photoURL', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: [], name: 'Trip' },
        'users/bob': { displayName: 'Bob Smith' },
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(200);
    const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1');
    expect(update.data['collaboratorProfiles.bob']).toEqual({
      uid: 'bob',
      firstName: 'Bob',
      photoURL: null,
    });
  });

  it('5c. falls back to firstName "User" and null photo when users/{uid} doc does not exist at all — join still succeeds', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: [], name: 'Trip' },
        // No 'users/bob' entry at all — profile lookup must fail soft, not
        // block the join.
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true, listId: 'L1', listName: 'Trip' });
    const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1');
    expect(update.data['collaboratorProfiles.bob']).toEqual({
      uid: 'bob',
      firstName: 'User',
      photoURL: null,
    });
  });

  it('6. with { asViewer: true }: viewerIds also gains authUid (in addition to collaboratorIds)', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': {
          ownerId: 'alice',
          inviteToken: 'tok123',
          collaboratorIds: [],
          viewerIds: [],
          name: 'Trip',
        },
        'users/bob': { firstName: 'Bob', photoURL: null },
      },
    });
    const res = await postJoin(app, { token: 'tok123', asViewer: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true, listId: 'L1', listName: 'Trip' });

    const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1');
    expect(update.data.collaboratorIds).toEqual({ _arrayUnion: ['bob'] });
    expect(update.data.viewerIds).toEqual({ _arrayUnion: ['bob'] });
  });

  it('7. returns 409 { error: "list_deleting" } when list.deletePending === true', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, ops } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': {
          ownerId: 'alice',
          inviteToken: 'tok123',
          collaboratorIds: [],
          deletePending: true,
          name: 'Trip',
        },
      },
    });
    const res = await postJoin(app, { token: 'tok123' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'list_deleting' });
    expect(ops).toHaveLength(0);
  });

  describe('8. input validation', () => {
    it('returns 400 when token is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildApp({ verifyIdToken });
      const res = await postJoin(app, {});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when token is not a string', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildApp({ verifyIdToken });
      const res = await postJoin(app, { token: 123456 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when token is an empty string', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildApp({ verifyIdToken });
      const res = await postJoin(app, { token: '' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      expect(ops).toHaveLength(0);
    });

    it('returns 400 when token is longer than 64 chars', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildApp({ verifyIdToken });
      const res = await postJoin(app, { token: 'a'.repeat(65) });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      expect(ops).toHaveLength(0);
    });

    it('accepts a token exactly 64 chars long (boundary)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const token = 'a'.repeat(64);
      const { app } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', inviteToken: token, collaboratorIds: [], name: 'Trip' },
          'users/bob': { firstName: 'Bob', photoURL: null },
        },
      });
      const res = await postJoin(app, { token });
      expect(res.status).toBe(200);
    });
  });

  describe('delete/revoke race between the indexed query and the transactional re-read', () => {
    // These simulate the list doc changing in the gap between the
    // `where('inviteToken', ...)` query (used only to find a candidate
    // ref) and the transaction's authoritative re-read of that ref. Both
    // scenarios must produce the same clean 404 a mistyped code would —
    // never a raw 500 — since from the joining user's perspective a
    // just-revoked invite link is indistinguishable from an invalid one.
    function buildRacingApp({ verifyIdToken, seed, mutateAfterQuery }) {
      const { firestoreMock, ops, store } = buildFirestoreMock(seed);
      const originalCollection = firestoreMock.collection;
      firestoreMock.collection = (name) => {
        const base = originalCollection(name);
        if (name !== 'lists') return base;
        return {
          ...base,
          where: (field, op, value) => {
            const q = base.where(field, op, value);
            return {
              limit: (n) => {
                const lim = q.limit(n);
                return {
                  get: async () => {
                    const snap = await lim.get();
                    // Simulate a write landing in the window between the
                    // query resolving and the transaction starting.
                    mutateAfterQuery(store);
                    return snap;
                  },
                };
              },
            };
          },
        };
      };
      let app;
      jest.isolateModules(() => {
        jest.doMock('../lib/firestore', () => ({
          firestore: firestoreMock,
          admin: {
            auth: () => ({ verifyIdToken }),
            firestore: {
              FieldValue: {
                serverTimestamp: () => ({ _ts: true }),
                arrayUnion: (...args) => ({ _arrayUnion: args }),
              },
            },
          },
        }));
        const { router } = require('../lib/listMembership');
        app = express();
        app.use(express.json());
        app.use(router);
      });
      return { app, ops };
    }

    it('list deleted between query and transaction -> 404 invalid_token, not 500', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildRacingApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: [], name: 'Trip' },
        },
        mutateAfterQuery: (store) => store.delete('lists/L1'),
      });
      const res = await postJoin(app, { token: 'tok123' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'invalid_token' });
      expect(ops).toHaveLength(0);
    });

    it('inviteToken rotated/cleared between query and transaction -> 404 invalid_token, not 500', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
      const { app, ops } = buildRacingApp({
        verifyIdToken,
        seed: {
          'lists/L1': { ownerId: 'alice', inviteToken: 'tok123', collaboratorIds: [], name: 'Trip' },
        },
        mutateAfterQuery: (store) => {
          store.set('lists/L1', { ...store.get('lists/L1'), inviteToken: 'rotated-by-owner' });
        },
      });
      const res = await postJoin(app, { token: 'tok123' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'invalid_token' });
      expect(ops).toHaveLength(0);
    });
  });
});
