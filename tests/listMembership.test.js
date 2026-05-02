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

function buildApp({ seed = {}, verifyIdToken, firestoreOverride, defaultFlags = true } = {}) {
  let app;
  let helpers;
  jest.isolateModules(() => {
    // Round-6 F19: the endpoint now fails closed when /configs/featureFlags
    // is missing or doesn't have a boolean freezeListMembershipWrites.
    // Default-seed it to `false` (the steady-state operational value) so
    // existing tests don't all need to spell out the flag. Tests that
    // exercise the missing-doc / missing-field cases pass `defaultFlags:
    // false` to opt out, then either omit the doc or seed it explicitly.
    const baseSeed = defaultFlags
      ? { 'configs/featureFlags': { freezeListMembershipWrites: false } }
      : {};
    const merged = { ...baseSeed, ...seed };

    // Round-7 F20: the endpoint requires lists.pinCount to be a positive
    // integer before decrementing. Inject a default of 1 into any seeded
    // list doc (path matching exactly `lists/{id}`, not subcollections)
    // that doesn't already specify pinCount. Tests exercising the F20
    // validation explicitly set pinCount to whatever they want.
    for (const path of Object.keys(merged)) {
      const segments = path.split('/');
      if (segments.length === 2 && segments[0] === 'lists') {
        const data = merged[path];
        if (data && typeof data === 'object' && !Object.prototype.hasOwnProperty.call(data, 'pinCount')) {
          merged[path] = { pinCount: 1, ...data };
        }
      }
    }

    helpers = buildFirestoreMock(merged);
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
            delete: () => ({ _delete: true }),
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

describe('POST /lists/:listId/members/:pinId/overrides (Phase 4 P4-7)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // Default healthy seed: list with alice as owner, bob as foreign-pin
  // owner, member doc present.
  function defaultSeed() {
    return {
      'lists/L1': {
        ownerId: 'alice',
        collaboratorIds: ['carol'],
        viewerIds: [],
        name: 'My List',
      },
      'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
      'lists/L1/members/P1': { pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice' },
    };
  }

  function postOverrides(app, body, token = 'good') {
    return request(app)
      .post('/lists/L1/members/P1/overrides')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  describe('auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { app } = buildApp({ verifyIdToken: jest.fn(), seed: defaultSeed() });
      const res = await request(app)
        .post('/lists/L1/members/P1/overrides')
        .send({ overrides: { category: 'food' } });
      expect(res.status).toBe(401);
    });

    it('returns 401 when verifyIdToken rejects', async () => {
      const verifyIdToken = jest.fn().mockRejectedValue(new Error('expired'));
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'food' } }, 'bad');
      expect(res.status).toBe(401);
    });
  });

  describe('input validation', () => {
    it('returns 400 when listId contains a percent-encoded slash', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await request(app)
        .post('/lists/L%2F1/members/P1/overrides')
        .set('Authorization', 'Bearer good')
        .send({ overrides: { category: 'food' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing the overrides key', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/overrides/);
    });

    it('returns 400 when overrides is not an object', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: 'food' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when overrides is an array', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: ['food'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when overrides has an unsupported key', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { rating: 5 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unsupported override field/);
    });

    it('returns 400 when category is not in the valid set', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'pizza' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid category/);
    });

    it('returns 400 when category is a non-string', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 42 } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when placeName is non-string non-null', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: 99 } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when placeName is empty string', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: '' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be empty/);
    });

    it('returns 400 when overrides object is empty (no fields supplied)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No override fields supplied/);
    });
  });

  describe('authorization', () => {
    it('succeeds when caller is the list owner setting category', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, changed: true });
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update).toBeDefined();
      expect(update.data['overrides.category']).toBe('food');
    });

    it('succeeds when caller is an editor (collaborator, not viewer)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'attraction' } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.category']).toBe('attraction');
    });

    it('returns 403 when caller is a viewer', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const seed = defaultSeed();
      seed['lists/L1'].viewerIds = ['carol'];
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(403);
      expect(ops).toHaveLength(0);
    });

    it('returns 403 when caller is not in collaboratorIds', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'mallory' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(403);
      expect(ops).toHaveLength(0);
    });

    it('returns 409 when role arrays are missing for non-owner (F18 carry-forward)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const seed = defaultSeed();
      delete seed['lists/L1'].viewerIds;
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });
  });

  describe('freeze gate (F19 carry-forward)', () => {
    it('returns 409 when freezeListMembershipWrites=true', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['configs/featureFlags'] = { freezeListMembershipWrites: true };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/frozen during migration/);
      expect(ops).toHaveLength(0);
    });

    it('returns 409 when configs/featureFlags doc is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        defaultFlags: false,
        seed: defaultSeed(),
      });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });
  });

  describe('member doc requirements', () => {
    it('returns 404 when list does not exist', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      delete seed['lists/L1'];
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/List not found/);
      expect(ops).toHaveLength(0);
    });

    // Codex P4-7 round-1 F24: pin-doc consistency. Mirrors the remove
    // endpoint's drift-cleanup policy — without these checks an editor
    // can persist phantom overrides on stale member docs.
    it('round-1 F24: returns 409 when pin doc no longer exists', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      delete seed['pins/P1'];
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Pin no longer exists/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F24: returns 409 when pin.listIds is malformed (non-array)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: 'bob', placeName: 'Cafe', listIds: 'L1' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/listIds is missing or malformed/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F24: returns 409 when pin.listIds is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: 'bob', placeName: 'Cafe' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-4 F34: returns 409 when member.overrides is a scalar (would crash Firestore nested update)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: 'corrupted-string',
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/overrides field is malformed/);
      expect(ops).toHaveLength(0);
    });

    it('round-4 F34: returns 409 when member.overrides is an array', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: ['food'],
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-8 F42: returns 409 when member.overrides is explicit null (corruption, not absent)', async () => {
      // Round-7 short-circuited on `overrides === null` and treated it
      // like the safe absent case. Round-8 catches this — null is
      // stored corruption (not unset), and a dotted update against it
      // would fail at commit with a 500.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: null,
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/overrides field is malformed/);
      expect(ops).toHaveLength(0);
    });

    it('round-4 F34: succeeds when member.overrides is absent (initial-write path)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);
      expect(ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1')).toBeDefined();
    });

    it('round-5 F36: returns 409 when member.overrides has a non-Object prototype (e.g. Date-like)', async () => {
      // Round-4 used `typeof === "object" && !Array.isArray`, which lets
      // Date / Timestamp / GeoPoint pass through. They don't support
      // dotted-field updates and the commit fails with a 500 instead of
      // the controlled 409 reconcile signal.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      // A Date instance is an object but its prototype is Date.prototype,
      // not Object.prototype — round-5 isPlainObject() rejects it.
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: new Date(),
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/overrides field is malformed/);
      expect(ops).toHaveLength(0);
    });

    it('round-5 F36: returns 409 when member.overrides is a class instance', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      class FakeTimestamp {
        constructor() { this.seconds = 1700000000; }
      }
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: new FakeTimestamp(),
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-5 F36: succeeds when member.overrides has a null prototype (Object.create(null))', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      const dictOverrides = Object.create(null);
      dictOverrides.placeName = 'Old Name';
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: dictOverrides,
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.category']).toBe('food');
    });

    // Codex P4-7 round-6 F38: existing override children must also be
    // validated, otherwise a prior bad write can poison a field and have
    // it survive an unrelated patch.

    it('round-6 F38: returns 409 when existing overrides.placeName contains HTML', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: '<script>alert(1)</script>' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      // Patching an UNRELATED field — round-5 would have left the bad
      // placeName in place and returned 200.
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/existing overrides\.placeName/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F38: returns 409 when existing overrides.category is not a valid enum value', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { category: 'pizza' }, // not in VALID_CATEGORIES
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/existing overrides\.category/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F38: returns 409 when existing overrides has an unsupported key', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { rating: 5 }, // not in ALLOWED_OVERRIDE_KEYS
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unsupported key/);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F40: caller CAN clear a corrupted existing placeName via null (skip-validation for overwritten keys)', async () => {
      // Round-6 would have rejected this because validateStoredOverrides
      // ran on pre-patch state. Round-7 skips validation for the keys
      // the request is overwriting or deleting, so recovery works.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: '<script>poisoned</script>' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { placeName: null } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.placeName']).toEqual({ _delete: true });
    });

    it('round-7 F40: caller CAN replace a corrupted existing placeName with a clean value', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: '<script>poisoned</script>' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { placeName: 'Cleaned Name' } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.placeName']).toBe('Cleaned Name');
    });

    it('round-7 F40: untouched corrupted fields still 409 (only OVERWRITTEN keys skip validation)', async () => {
      // Existing overrides has TWO bad fields: placeName (HTML) and
      // category (invalid enum). Request only patches placeName.
      // category is still validated → 409.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: '<bad>', category: 'pizza' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { placeName: 'Cleaned' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/existing overrides\.category/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F38: returns 409 when existing overrides.placeName is null (should have been cleared via FieldValue.delete)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: null },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-4 F34: succeeds when member.overrides is a plain object (round-trip update path)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: 'Old Name' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.category']).toBe('food');
    });

    it('round-2 F31: returns 409 when member doc pinId does not match URL pinId', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = { pinId: 'P_DIFFERENT', pinOwnerId: 'bob', addedBy: 'alice' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pinId does not match/);
      expect(ops).toHaveLength(0);
    });

    it('round-3 F33: returns 409 when both pin.userId and member.pinOwnerId are missing (undefined === undefined would pass)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { placeName: 'Cafe', listIds: ['L1'] }; // no userId
      seed['lists/L1/members/P1'] = { pinId: 'P1', addedBy: 'alice' }; // no pinOwnerId
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/missing\/malformed owner id/);
      expect(ops).toHaveLength(0);
    });

    it('round-3 F33: returns 409 when both pin.userId and member.pinOwnerId are null', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: null, placeName: 'Cafe', listIds: ['L1'] };
      seed['lists/L1/members/P1'] = { pinId: 'P1', pinOwnerId: null, addedBy: 'alice' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-3 F33: returns 409 when pin.userId is non-string', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: 42, placeName: 'Cafe', listIds: ['L1'] };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-2 F31: returns 409 when member doc pinOwnerId does not match pin.userId', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = { pinId: 'P1', pinOwnerId: 'WRONG_OWNER', addedBy: 'alice' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pinOwnerId does not match/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F24: returns 409 when pin.listIds does not include this list (drift)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: 'bob', placeName: 'Cafe', listIds: ['L_OTHER'] };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/does not claim membership in this list/);
      expect(ops).toHaveLength(0);
    });

    it('returns 404 when member doc does not exist (cannot override non-membership)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      delete seed['lists/L1/members/P1'];
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Member doc not found/);
      expect(ops).toHaveLength(0);
    });
  });

  describe('field merge semantics', () => {
    it('sets multiple override fields in a single request', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, {
        overrides: {
          category: 'food',
          placeName: 'Custom Place',
          formattedAddress: '123 Main St',
        },
      });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.category']).toBe('food');
      expect(update.data['overrides.placeName']).toBe('Custom Place');
      expect(update.data['overrides.formattedAddress']).toBe('123 Main St');
    });

    it('null clears a specific override field via FieldValue.delete', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'].overrides = { category: 'food', placeName: 'Old' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: null } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.category']).toEqual({ _delete: true });
      // placeName field NOT included → unchanged.
      expect(update.data['overrides.placeName']).toBeUndefined();
    });

    it('truncates long placeName to 256 code points', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const long = 'A'.repeat(500);
      const res = await postOverrides(app, { overrides: { placeName: long } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(Array.from(update.data['overrides.placeName']).length).toBeLessThanOrEqual(256);
    });

    it('truncates astral chars by code points (no lone surrogates)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const emoji = '\u{1F600}'.repeat(300);
      const res = await postOverrides(app, { overrides: { placeName: emoji } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(Array.from(update.data['overrides.placeName']).length).toBe(256);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(update.data['overrides.placeName'])).toBe(false);
    });

    // Codex P4-7 round-1 F23: sanitize attacker-controlled display strings.
    it('round-1 F23: rejects placeName that is whitespace-only', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: '   \t  ' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/whitespace-only/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: rejects placeName containing newline (control char)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe\nName' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/control characters/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: rejects formattedAddress containing NUL byte', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { formattedAddress: '123 Main St' } });
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: rejects placeName with HTML angle brackets', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: '<script>alert(1)</script>' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/angle brackets/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: rejects placeName containing a Unicode bidi override char', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      // U+202E RIGHT-TO-LEFT OVERRIDE — Trojan-Source-style spoofing.
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe‮Name' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invisible|bidi/);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: trims leading/trailing whitespace before persisting', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: '   Cafe Name   ' } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.placeName']).toBe('Cafe Name');
    });

    it('round-2 F30: rejects placeName containing zero-width space (U+200B) — survives trim but invisible', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe​Name' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invisible|format/);
      expect(ops).toHaveLength(0);
    });

    it('round-2 F30: rejects placeName containing WORD JOINER (U+2060)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe⁠Name' } });
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('round-2 F30: rejects placeName containing Byte Order Mark (U+FEFF) embedded in the string', async () => {
      // .trim() strips a leading/trailing U+FEFF (it's part of the ES whitespace
      // set), but an embedded BOM survives — the regex catches it.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: 'Cafe﻿Name' } });
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('round-2 F30: rejects a visually blank placeName composed entirely of zero-width chars', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      // Visually invisible — survives .trim() because it isn't whitespace.
      const res = await postOverrides(app, { overrides: { placeName: '​‌‍⁠' } });
      expect(res.status).toBe(400);
      expect(ops).toHaveLength(0);
    });

    it('round-1 F23: accepts ampersand and other safe punctuation (e.g., "Bed & Breakfast")', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { placeName: "Bed & Breakfast — O'Reilly's" } });
      expect(res.status).toBe(200);
      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update.data['overrides.placeName']).toBe("Bed & Breakfast — O'Reilly's");
    });

    // Codex P4-7 round-9 F44: cross-user overrides need an audit trail
    // mirroring the remove endpoint's list_member_removed_by_editor.

    it('round-9 F44: writes a list_member_overridden_by_editor event for foreign-pin overrides', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' }); // owner; pin owner is bob
      const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
      const res = await postOverrides(app, { overrides: { category: 'food', placeName: 'Custom' } });
      expect(res.status).toBe(200);

      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_overridden_by_editor'
      );
      expect(event).toBeDefined();
      expect(event.data.userId).toBe('bob');           // recipient = pin owner
      expect(event.data.overriddenBy).toBe('alice');   // actor
      expect(event.data.listId).toBe('L1');
      expect(event.data.pinId).toBe('P1');
      expect(event.data.changedFields).toEqual(expect.arrayContaining(['category', 'placeName']));
      expect(event.data.changedFields.length).toBe(2);
      expect(event.data.listName).toBe('My List');
      expect(event.data.pinPlaceName).toBe('Cafe');
    });

    it('round-9 F44: does NOT write an event for self-action (caller IS the pin owner)', async () => {
      // Alice owns the list AND the pin in this seed.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['pins/P1'] = { userId: 'alice', placeName: 'Cafe', listIds: ['L1'] };
      seed['lists/L1/members/P1'] = { pinId: 'P1', pinOwnerId: 'alice', addedBy: 'alice' };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);

      const event = ops.find(
        (o) => o.type === 'set' && o.data && o.data.type === 'list_member_overridden_by_editor'
      );
      expect(event).toBeUndefined();
    });

    it('round-10 F46: re-sending the same value is a semantic no-op — no write, no event', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { category: 'food' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { category: 'food' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, changed: false });
      // No member-doc write, no event.
      expect(ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1')).toBeUndefined();
      expect(ops.find((o) => o.data && o.data.type === 'list_member_overridden_by_editor')).toBeUndefined();
    });

    it('round-10 F46: clearing an already-absent field is a no-op', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      // No existing overrides at all.
      const { app, ops } = buildApp({ verifyIdToken, seed });
      const res = await postOverrides(app, { overrides: { placeName: null } });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      expect(ops.find((o) => o.type === 'update')).toBeUndefined();
    });

    it('round-10 F46: partial change writes only the actually-changed field; event reflects only that field', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { category: 'food', placeName: 'Existing' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      // Re-send same category + change placeName.
      const res = await postOverrides(app, {
        overrides: { category: 'food', placeName: 'New Name' },
      });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);

      const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
      expect(update).toBeDefined();
      // Only the placeName key in the patch — category was unchanged.
      expect(Object.keys(update.data)).toEqual(['overrides.placeName']);
      expect(update.data['overrides.placeName']).toBe('New Name');

      const event = ops.find((o) => o.data && o.data.type === 'list_member_overridden_by_editor');
      expect(event.data.changedFields).toEqual(['placeName']);
    });

    it('round-9 F44: changedFields list reflects exactly the keys touched (set + delete)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const seed = defaultSeed();
      seed['lists/L1/members/P1'] = {
        pinId: 'P1', pinOwnerId: 'bob', addedBy: 'alice',
        overrides: { placeName: 'Existing' },
      };
      const { app, ops } = buildApp({ verifyIdToken, seed });
      // Set category + clear placeName.
      const res = await postOverrides(app, { overrides: { category: 'food', placeName: null } });
      expect(res.status).toBe(200);
      const event = ops.find((o) => o.data && o.data.type === 'list_member_overridden_by_editor');
      expect(event.data.changedFields.sort()).toEqual(['category', 'placeName']);
    });

    it('accepts all 8 valid Category enum values', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const cats = ['food', 'accommodation', 'attraction', 'nature', 'shopping', 'wellness', 'entertainment', 'other'];
      for (const cat of cats) {
        const { app, ops } = buildApp({ verifyIdToken, seed: defaultSeed() });
        const res = await postOverrides(app, { overrides: { category: cat } });
        expect(res.status).toBe(200);
        const update = ops.find((o) => o.type === 'update' && o.path === 'lists/L1/members/P1');
        expect(update.data['overrides.category']).toBe(cat);
      }
    });
  });
});

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

    it('round-6 F18: fails closed with 409 when viewerIds is undefined and caller is in collaboratorIds (auth-bypass closed)', async () => {
      // Without this fix, a viewer in collaboratorIds with viewerIds
      // simply deleted from the list doc would be silently classified as
      // editor (`!isViewer` becomes vacuously true). Now: missing role
      // arrays for non-owners → 409.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: ['bob', 'carol'],
            // viewerIds intentionally absent
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
      expect(res.body.error).toMatch(/missing or malformed/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F18: fails closed with 409 when collaboratorIds is undefined and caller is non-owner', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'carol' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            // collaboratorIds intentionally absent
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

  describe('pinCount validation (Codex round-7 F20)', () => {
    // FieldValue.increment(-1) silently creates the pinCount field at -1
    // when missing, and produces undocumented behavior on non-numeric.
    // The endpoint must validate pinCount is a positive integer before
    // decrementing — otherwise a recoverable drift state (which admin
    // reconcile-pin-counts can repair) becomes a worse, less-detectable
    // corruption.

    it('round-7 F20: fails closed with 409 when pinCount is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          // Override the auto-injected default by setting pinCount to undefined.
          // (The helper checks hasOwnProperty, so explicitly assigning null
          // bypasses the default while still matching the missing-field semantic.)
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: undefined,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pinCount/);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F20: fails closed with 409 when pinCount is non-numeric (string)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: '5',
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F20: fails closed with 409 when pinCount is a non-integer number (decimal)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: 1.5,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F20: fails closed with 409 when pinCount is 0 (decrement would go negative)', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: 0,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F20: fails closed with 409 when pinCount is already negative', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: -1,
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(ops).toHaveLength(0);
    });

    it('round-7 F20: drift case (pin does not claim membership) bypasses pinCount check entirely', async () => {
      // When pinClaimsMembership is false, no decrement happens; the
      // pinCount validator must NOT fire. Otherwise legitimate drift
      // cleanup of a stale member doc would also fail closed.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        seed: {
          'lists/L1': {
            ownerId: 'alice',
            collaboratorIds: [],
            viewerIds: [],
            name: 'My List',
            pinCount: undefined, // would normally fail F20
          },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L_OTHER'] }, // drift
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(ops.some((o) => o.type === 'delete' && o.path === 'lists/L1/members/P1')).toBe(true);
      expect(ops.some((o) => o.type === 'update' && o.path === 'lists/L1')).toBe(false);
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

    it('round-6 F19: fails closed with 409 when /configs/featureFlags doc does not exist', async () => {
      // Round-5 treated missing doc as "not frozen" (fail-open). Round-6
      // tightens this — if an admin accidentally deletes the config doc
      // or a fresh environment hasn't initialized it, the endpoint must
      // refuse to mutate. Operators see a 409 and know to initialize.
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        defaultFlags: false,
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
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/missing/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F19: fails closed with 409 when freezeListMembershipWrites field is missing', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        defaultFlags: false,
        seed: {
          'configs/featureFlags': { somethingElse: true }, // doc exists but field missing
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
          'lists/L1/members/P1': { pinId: 'P1' },
        },
      });
      const res = await request(app)
        .post('/lists/L1/members/P1/remove')
        .set('Authorization', 'Bearer good');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/freezeListMembershipWrites/);
      expect(ops).toHaveLength(0);
    });

    it('round-6 F19: fails closed with 409 when freezeListMembershipWrites is non-boolean', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, ops } = buildApp({
        verifyIdToken,
        defaultFlags: false,
        seed: {
          'configs/featureFlags': { freezeListMembershipWrites: 'true' }, // STRING, not bool
          'lists/L1': { ownerId: 'alice', collaboratorIds: [], viewerIds: [], name: 'My List' },
          'pins/P1': { userId: 'bob', placeName: 'Cafe', listIds: ['L1'] },
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
