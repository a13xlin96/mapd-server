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

  describe('legacy acknowledgement never fabricates behavioral history', () => {
    it('repeated requests without any saved pins perform no database writes', async () => {
      const { app, setCalls } = buildApp({ verifyIdToken: jest.fn().mockResolvedValue({ uid: 'alice' }) });
      for (let n = 0; n < 3; n++) {
        const response = await post(app, { category: 'food', city: 'Kyoto', country: 'JP', userId: 'someone-else' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
      }
      expect(setCalls).toEqual([]);
    });
    it('does not need a profile write even when Firestore is unavailable', async () => {
      const { app, setCalls } = buildApp({ verifyIdToken: jest.fn().mockResolvedValue({ uid: 'alice' }), firestoreOverride: null });
      expect((await post(app, { category: 'food' })).status).toBe(200);
      expect(setCalls).toEqual([]);
    });
  });
});
