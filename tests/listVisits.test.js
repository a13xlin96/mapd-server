// Unit tests for the membership-checked visit read endpoint:
// GET /lists/:listId/visits
//
// This replaces the client's collectionGroup('visits')
// .where('userId','in', otherUids) query that powered the "visited by
// [collaborator]" filter chips — the S3-follow-on visits-privacy-lockdown
// plan denies non-own collection-group visit queries from the client
// (they let any signed-in user enumerate pin IDs app-wide via the ref
// paths in the query result). This endpoint is the sanctioned server-side
// replacement, with a bonus privacy improvement over the old client
// query: results are scoped to the list's OWN pins, whereas the old
// client query fetched a collaborator's visits across every pin they've
// ever touched, on any list, shared or not.
//
// Harness mirrors tests/listPins.test.js's hand-rolled raw-ops-recording
// mock (not tests/helpers/fakeFirestore.js), extended to also support:
//   - Query#select() (field-mask, recorded so we can assert it's used)
//   - firestore.collectionGroup('visits') with a where('userId','in',[...])
//     filter, faked over the same flat doc store, deriving each visit
//     doc's parent pin id from its store path (pins/{pinId}/visits/{uid}).

const express = require('express');
const request = require('supertest');

function buildFirestoreMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const queries = []; // every terminal get() against a query (not a bare doc().get())

  function makeDocRef(collectionName, id) {
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

  function matches(data, filter) {
    const { field, op, value } = filter;
    if (op === 'array-contains') {
      const arr = data && data[field];
      return Array.isArray(arr) && arr.includes(value);
    }
    if (op === 'in') {
      if (!Array.isArray(value)) throw new Error("'in' filter requires an array value");
      return value.includes(data && data[field]);
    }
    throw new Error(`firestore mock only supports 'array-contains'/'in' in where(), got "${op}"`);
  }

  // scope: { kind: 'collection', name } | { kind: 'collectionGroup', name }
  function makeQuery(scope, state = { filters: [], select: undefined, limitN: undefined }) {
    return {
      where: (field, op, value) => makeQuery(scope, {
        ...state,
        filters: [...state.filters, { field, op, value }],
      }),
      select: (...fields) => makeQuery(scope, { ...state, select: fields }),
      limit: (n) => makeQuery(scope, { ...state, limitN: n }),
      get: async () => {
        queries.push({ scope: scope.kind, collection: scope.name, ...state });

        const docs = [];
        for (const [path, data] of store.entries()) {
          const parts = path.split('/');
          let docId;
          let parentDocId = null;

          if (scope.kind === 'collection') {
            // Only top-level docs directly under this collection name.
            if (parts.length !== 2 || parts[0] !== scope.name) continue;
            docId = parts[1];
          } else {
            // collectionGroup: any doc whose immediate parent collection
            // name matches, regardless of nesting depth.
            if (parts.length < 2 || parts[parts.length - 2] !== scope.name) continue;
            docId = parts[parts.length - 1];
            parentDocId = parts.length >= 4 ? parts[parts.length - 3] : null;
          }

          if (!state.filters.every((f) => matches(data, f))) continue;

          const ref = scope.kind === 'collectionGroup'
            ? { id: docId, parent: { parent: parentDocId ? { id: parentDocId } : null } }
            : { id: docId, parent: { parent: null } };

          let docData = data;
          if (Array.isArray(state.select)) {
            if (state.select.length === 0) {
              docData = {};
            } else {
              docData = {};
              for (const f of state.select) docData[f] = data[f];
            }
          }

          docs.push({ id: docId, ref, data: () => docData });
          if (state.limitN !== undefined && docs.length >= state.limitN) break;
        }
        return { docs };
      },
    };
  }

  function collectionFactory(name) {
    return {
      doc: (id) => makeDocRef(name, id),
      where: (field, op, value) => makeQuery({ kind: 'collection', name }).where(field, op, value),
    };
  }

  function collectionGroupFactory(name) {
    return makeQuery({ kind: 'collectionGroup', name });
  }

  return {
    firestoreMock: { collection: collectionFactory, collectionGroup: collectionGroupFactory },
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

function getVisits(app, listId, token = 'good') {
  return request(app)
    .get(`/lists/${listId}/visits`)
    .set('Authorization', `Bearer ${token}`);
}

function inQueries(queries) {
  return queries.filter((q) => q.filters.some((f) => f.op === 'in'));
}

describe('GET /lists/:listId/visits', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('1. returns 400 for an invalid listId', async () => {
    // '..' gets normalized away by URL resolution before it ever reaches
    // Express, so it can't be used to exercise isValidDocId's rejection
    // path here — use the reserved `__..__` dunder pattern instead, which
    // isValidDocId also rejects but which survives as a literal path
    // segment.
    const { app, queries } = buildApp({ verifyIdToken: jest.fn().mockResolvedValue({ uid: 'alice' }) });
    const res = await getVisits(app, '__reserved__');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid listId' });
    expect(queries).toHaveLength(0);
  });

  it('2. returns 401 when unauthenticated (no Bearer token)', async () => {
    const { app, queries } = buildApp({ verifyIdToken: jest.fn() });
    const res = await request(app).get('/lists/L1/visits');
    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('3. returns 404 { error: "list_not_found" } when the list does not exist', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app, queries } = buildApp({ verifyIdToken, seed: {} });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'list_not_found' });
    expect(queries).toHaveLength(0);
  });

  it('4. returns 403 { error: "not_a_member" } for a non-member, non-featured list', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'eve' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: ['bob'], name: 'Trip' },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_a_member' });
    expect(queries).toHaveLength(0);
  });

  it('5. returns 403 for a stranger on a FEATURED list (unlike GET /pins, isFeatured does NOT grant visit access)', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'stranger' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: [], isFeatured: true, name: 'Best of NYC' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
        'pins/P1/visits/alice': { userId: 'alice', visited: true, visitedAt: '2026-01-01' },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_a_member' });
    expect(queries).toHaveLength(0);
  });

  it('6. returns 200 for the OWNER, scoped to the list\'s own pins, with field-minimized visits', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: ['bob'], name: 'Trip' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
        // bob's pin NOT in this list — privacy improvement: bob's visit
        // there must not leak into this list's response.
        'pins/P2': { userId: 'bob', listIds: ['L2'] },
        'pins/P1/visits/bob': {
          userId: 'bob',
          visited: true,
          wouldGoBack: false,
          visitedAt: '2026-02-01',
          updatedAt: '2026-02-02',
          // decoys: personal content that must be stripped, not activity state
          visitNote: 'great brunch spot',
          verdictReason: 'overrated',
        },
        'pins/P2/visits/bob': { userId: 'bob', visited: true, visitedAt: '2026-03-01' },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body.visits).toEqual([
      {
        pinId: 'P1', userId: 'bob', visited: true, wouldGoBack: false, visitedAt: '2026-02-01', updatedAt: '2026-02-02',
      },
    ]);
    // field minimization: activity-state fields come through, but the
    // seeded `visitNote`/`verdictReason` personal-content decoys do not.
    expect(Object.keys(res.body.visits[0]).sort()).toEqual(
      ['pinId', 'updatedAt', 'userId', 'visited', 'visitedAt', 'wouldGoBack'].sort(),
    );

    // pins query used a field mask (select) rather than fetching full docs
    const pinsQuery = queries.find((q) => q.collection === 'pins');
    expect(pinsQuery).toBeDefined();
    expect(pinsQuery.select).toEqual([]);
    expect(pinsQuery.limitN).toBe(500);
  });

  it('7. returns 200 for a COLLABORATOR', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'bob' });
    const { app } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: ['bob'], name: 'Trip' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
        'pins/P1/visits/alice': {
          userId: 'alice', visited: true, wouldGoBack: true, visitedAt: '2026-01-05', updatedAt: '2026-01-06',
        },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body.visits).toEqual([
      {
        pinId: 'P1', userId: 'alice', visited: true, wouldGoBack: true, visitedAt: '2026-01-05', updatedAt: '2026-01-06',
      },
    ]);
  });

  it('8. chunks member uids into groups of <= 30 for the "in" query when the list has > 30 members', async () => {
    const collaboratorIds = [];
    for (let i = 0; i < 34; i += 1) collaboratorIds.push(`collab${i}`);
    // owner + 34 collaborators = 35 total members
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app, queries } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds, name: 'Big trip' },
        'pins/P1': { userId: 'alice', listIds: ['L1'] },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(200);

    const ins = inQueries(queries).filter((q) => q.scope === 'collectionGroup');
    expect(ins).toHaveLength(2);
    const sizes = ins.map((q) => q.filters.find((f) => f.op === 'in').value.length).sort((a, b) => a - b);
    expect(sizes).toEqual([5, 30]);

    const allChunked = ins.flatMap((q) => q.filters.find((f) => f.op === 'in').value);
    expect(new Set(allChunked).size).toBe(35);
  });

  it('9. returns { visits: [] } when the list has no pins', async () => {
    const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
    const { app } = buildApp({
      verifyIdToken,
      seed: {
        'lists/L1': { ownerId: 'alice', collaboratorIds: [], name: 'Empty' },
      },
    });
    const res = await getVisits(app, 'L1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visits: [] });
  });
});
