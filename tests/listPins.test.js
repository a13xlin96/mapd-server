// Unit tests for the membership-checked pin read endpoint:
// GET /lists/:listId/pins
//
// Client Firestore rules will soon deny collection QUERIES over other
// users' pins (single-doc gets stay allowed) — see the S3 pins-privacy-
// lockdown plan. The legacy shared-list fallback and featured-list cloning
// both run `where('listIds','array-contains', listId)` over foreign pins;
// this endpoint becomes their sanctioned path, checking membership /
// featured status with the admin SDK before running that query itself.
//
// Read-only (no transaction needed), so the harness is a simpler
// raw-ops-recording mock than listJoin.test.js's — no runTransaction, just
// collection().doc().get() for the list lookup and
// collection().where().limit().get() for the pins query. Mirrors
// listJoin.test.js's decision to hand-roll a mock instead of reusing
// tests/helpers/fakeFirestore.js, since we want to assert the exact query
// shape (field/op/value/limit) was used, not just the resulting data.

const express = require('express');
const request = require('supertest');

function buildFirestoreMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const queries = []; // records every where()+limit() call for assertions

  function makeRef(collectionName, id) {
    return {
      id,
      _path: `${collectionName}/${id}`,
      get: async () => {
        const data = store.get(`${collectionName}/${id}`);
        return {
          exists: data !== undefined,
          id,
          data: () => data,
        };
      },
    };
  }

  function collectionFactory(name) {
    return {
      doc: (id) => makeRef(name, id),
      where: (field, op, value) => ({
        limit: (n) => {
          queries.push({ collection: name, field, op, value, limit: n });
          return {
            get: async () => {
              const docs = [];
              for (const [path, data] of store.entries()) {
                if (!path.startsWith(`${name}/`)) continue;
                const rest = path.slice(name.length + 1);
                if (rest.includes('/')) continue; // skip subcollection docs
                if (op === 'array-contains') {
                  const arr = data && data[field];
                  if (Array.isArray(arr) && arr.includes(value)) {
                    docs.push({ id: rest, data: () => data });
                  }
                } else {
                  throw new Error(`firestore mock only supports 'array-contains' in where(), got "${op}"`);
                }
                if (docs.length >= n) break;
              }
              return { docs };
            },
          };
        },
      }),
    };
  }

  return {
    firestoreMock: { collection: collectionFactory },
    queries,
    store,
  };
}

function buildApp({ seed = {}, verifyIdToken } = {}) {
  let app;
  let helpers;
  jest.isolateModules(() => {
    helpers = buildFirestoreMock(seed);
    jest.doMock('../lib/firestore', () => ({
      firestore: helpers.firestoreMock,
      admin: {
        auth: () => ({ verifyIdToken }),
        firestore: () => helpers.firestoreMock,
      },
    }));
    const { router } = require('../lib/listMembership');
    app = express();
    app.use(express.json());
    app.use(router);
  });
  return { app, ...helpers };
}

function getPins(app, listId, token = 'good') {
  return request(app)
    .get(`/lists/${listId}/pins`)
    .set('Authorization', `Bearer ${token}`);
}

describe('GET /lists/:listId/pins', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('1. returns 401 when unauthenticated (no Bearer token)', async () => {
    const { app, queries } = buildApp({ verifyIdToken: jest.fn() });
    const res = await request(app).get('/lists/L1/pins');
    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('2. returns 404 { error: "list_not_found" } when the list does not exist', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, queries } = buildApp({ verifyIdToken, seed: {} });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'list_not_found' });
    expect(queries).toHaveLength(0);
  });

  it('3. returns 403 { error: "not_a_member" } when requester is not owner, not a collaborator, and list is not featured', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'eve' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: ['bob'], name: 'Trip' },
      },
    });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_a_member' });
    expect(queries).toHaveLength(0);
  });

  it('4. returns 200 { pins: [...] } for the OWNER, with every pin where listIds array-contains listId', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: [], name: 'Trip' },
        'pins/P1': { userId: 'alice', listIds: ['L1'], placeName: 'Cafe' },
        'pins/P2': { userId: 'bob', listIds: ['L1', 'L2'], placeName: 'Park' },
        'pins/P3': { userId: 'carol', listIds: ['L2'], placeName: 'Museum' },
      },
    });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body.pins).toHaveLength(2);
    const ids = res.body.pins.map((p) => p.id).sort();
    expect(ids).toEqual(['P1', 'P2']);
    const p1 = res.body.pins.find((p) => p.id === 'P1');
    expect(p1).toEqual({ id: 'P1', userId: 'alice', listIds: ['L1'], placeName: 'Cafe' });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({
      collection: 'pins', field: 'listIds', op: 'array-contains', value: 'L1', limit: 500,
    });
  });

  it('5. returns 200 for a COLLABORATOR', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: ['bob'], name: 'Trip' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
      },
    });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body.pins).toEqual([{ id: 'P1', userId: 'alice', listIds: ['L1'] }]);
  });

  it('6. returns 200 for any authenticated user when list.isFeatured === true', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'stranger' });
    const { app } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: [], isFeatured: true, name: 'Best of NYC' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
      },
    });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body.pins).toEqual([{ id: 'P1', userId: 'alice', listIds: ['L1'] }]);
  });

  it('7. caps the pins query at .limit(500)', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: [], name: 'Trip' },
      },
    });
    const res = await getPins(app, 'L1');
    expect(res.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].limit).toBe(500);
  });
});
