// Unit tests for POST /interest-profile/pin-saved (S5 interest-profile
// server-side plan, Task 1). Mirrors listMembership.test.js's hand-rolled
// firestore mock: a Map-backed store, but here doc().set(data, {merge})
// is called directly (no transaction) since the route does a single
// merge-set on users/{uid}/interestProfile/latest.

const express = require('express');
const request = require('supertest');

function buildFirestoreMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const setCalls = [];

  function docRef(path) {
    return {
      _path: path,
      collection: (sub) => collectionRef(`${path}/${sub}`),
      set: async (data, opts) => {
        setCalls.push({ path, data, opts });
        const existing = opts && opts.merge ? (store.get(path) || {}) : {};
        store.set(path, { ...existing, ...data });
      },
      get: async () => (store.has(path)
        ? { exists: true, data: () => store.get(path) }
        : { exists: false, data: () => undefined }),
    };
  }

  function collectionRef(name) {
    return { doc: (id) => docRef(`${name}/${id}`) };
  }

  return {
    firestoreMock: { collection: (name) => collectionRef(name) },
    setCalls,
    store,
  };
}

function buildApp({ verifyIdToken, firestoreOverride } = {}) {
  let app;
  let helpers;
  jest.isolateModules(() => {
    helpers = buildFirestoreMock();
    const firestore = firestoreOverride === undefined ? helpers.firestoreMock : firestoreOverride;
    jest.doMock('../lib/firestore', () => ({
      firestore,
      admin: {
        auth: () => ({ verifyIdToken }),
        firestore: {
          FieldValue: {
            serverTimestamp: () => ({ _ts: true }),
            increment: (n) => ({ _increment: n }),
          },
        },
      },
    }));
    const { interestProfileRouter } = require('../lib/interestProfile');
    app = express();
    app.use(express.json());
    app.use(interestProfileRouter);
  });
  return { app, ...helpers };
}

describe('POST /interest-profile/pin-saved', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function post(app, body, token = 'good') {
    const req = request(app).post('/interest-profile/pin-saved');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.set('Content-Type', 'application/json').send(body);
  }

  describe('auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { app } = buildApp({ verifyIdToken: jest.fn() });
      const res = await post(app, { category: 'food' }, null);
      expect(res.status).toBe(401);
    });

    it('returns 401 when verifyIdToken rejects', async () => {
      const verifyIdToken = jest.fn().mockRejectedValue(new Error('expired'));
      const { app } = buildApp({ verifyIdToken });
      const res = await post(app, { category: 'food' }, 'bad');
      expect(res.status).toBe(401);
    });
  });

  describe('input validation', () => {
    const verifyIdToken = () => jest.fn().mockResolvedValue({ uid: 'alice' });

    it('returns 400 with invalid_category when category is missing', async () => {
      const { app } = buildApp({ verifyIdToken: verifyIdToken() });
      const res = await post(app, {});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_category' });
    });

    it('returns 400 when category is not a string', async () => {
      const { app } = buildApp({ verifyIdToken: verifyIdToken() });
      const res = await post(app, { category: 42 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_category' });
    });

    it('returns 400 when category is an empty string', async () => {
      const { app } = buildApp({ verifyIdToken: verifyIdToken() });
      const res = await post(app, { category: '' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_category' });
    });

    it('returns 400 when category is over 64 chars', async () => {
      const { app } = buildApp({ verifyIdToken: verifyIdToken() });
      const res = await post(app, { category: 'a'.repeat(65) });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_category' });
    });

    it('accepts a category exactly 64 chars', async () => {
      const { app } = buildApp({ verifyIdToken: verifyIdToken() });
      const res = await post(app, { category: 'a'.repeat(64) });
      expect(res.status).toBe(200);
    });
  });

  describe('success — merge-set on users/{authUid}/interestProfile/latest', () => {
    it('writes totalPins increment, category, city, country, updatedAt', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, setCalls } = buildApp({ verifyIdToken });
      const res = await post(app, { category: 'food', city: 'Austin', country: 'US' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].path).toBe('users/alice/interestProfile/latest');
      expect(setCalls[0].opts).toEqual({ merge: true });
      expect(setCalls[0].data).toEqual({
        totalPins: { _increment: 1 },
        lastPinCategory: 'food',
        lastPinCity: 'Austin',
        lastPinCountry: 'US',
        updatedAt: { _ts: true },
      });
    });

    it('uid comes from the TOKEN — a body userId is ignored on the Bearer path', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, setCalls } = buildApp({ verifyIdToken });
      const res = await post(app, {
        category: 'food',
        city: 'Austin',
        country: 'US',
        userId: 'someone-else',
      });

      expect(res.status).toBe(200);
      expect(setCalls).toHaveLength(1);
      // The write path used authUid ('alice'), not body.userId.
      expect(setCalls[0].path).toBe('users/alice/interestProfile/latest');
      expect(setCalls[0].path).not.toContain('someone-else');
    });

    it('clamps city/country to 128 chars', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, setCalls } = buildApp({ verifyIdToken });
      const longCity = 'c'.repeat(200);
      const longCountry = 'n'.repeat(200);
      await post(app, { category: 'food', city: longCity, country: longCountry });

      expect(setCalls[0].data.lastPinCity).toBe('c'.repeat(128));
      expect(setCalls[0].data.lastPinCountry).toBe('n'.repeat(128));
    });

    it('coerces city/country to null when not strings', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, setCalls } = buildApp({ verifyIdToken });
      await post(app, { category: 'food', city: 12345, country: null });

      expect(setCalls[0].data.lastPinCity).toBeNull();
      expect(setCalls[0].data.lastPinCountry).toBeNull();
    });

    it('coerces missing city/country to null', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app, setCalls } = buildApp({ verifyIdToken });
      await post(app, { category: 'food' });

      expect(setCalls[0].data.lastPinCity).toBeNull();
      expect(setCalls[0].data.lastPinCountry).toBeNull();
    });
  });

  describe('firestore unavailable', () => {
    it('returns 503 when firestore is not configured', async () => {
      const verifyIdToken = jest.fn().mockResolvedValue({ uid: 'alice' });
      const { app } = buildApp({ verifyIdToken, firestoreOverride: null });
      const res = await post(app, { category: 'food' });
      expect(res.status).toBe(503);
    });
  });
});
