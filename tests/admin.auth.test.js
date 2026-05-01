// Admin auth middleware behavior. Doesn't touch Firestore — just verifies
// the bearer-token check rejects/accepts correctly.

const express = require('express');
const request = require('supertest');

// Mock firestore lib so the admin router doesn't try to initialize firebase-admin.
jest.mock('../lib/firestore', () => ({
  firestore: { /* methods populated by individual tests if needed */ },
  admin: { firestore: { FieldValue: { serverTimestamp: () => ({ _ts: true }) } } },
}));

describe('admin auth middleware', () => {
  let app;
  let originalEnv;
  let originalSettle;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    originalSettle = process.env.FREEZE_SETTLE_MS;
    process.env.FREEZE_SETTLE_MS = '0'; // skip settle delay in tests
    jest.resetModules();
  });

  afterEach(() => {
    process.env.ADMIN_TOKEN = originalEnv;
    process.env.FREEZE_SETTLE_MS = originalSettle;
  });

  it('rejects with 503 when ADMIN_TOKEN env var is unset', async () => {
    delete process.env.ADMIN_TOKEN;
    // Reload admin module so the new env value is picked up.
    jest.isolateModules(() => {
      const { router } = require('../lib/admin');
      app = express();
      app.use(express.json());
      app.use(router);
    });
    const res = await request(app).get('/admin/feature-flags');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Admin endpoints disabled/);
  });

  it('rejects with 403 when X-Admin-Token header is missing', async () => {
    process.env.ADMIN_TOKEN = 'secret';
    jest.isolateModules(() => {
      const { router } = require('../lib/admin');
      app = express();
      app.use(express.json());
      app.use(router);
    });
    const res = await request(app).get('/admin/feature-flags');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin token/);
  });

  it('rejects with 403 when X-Admin-Token does not match', async () => {
    process.env.ADMIN_TOKEN = 'secret';
    jest.isolateModules(() => {
      const { router } = require('../lib/admin');
      app = express();
      app.use(express.json());
      app.use(router);
    });
    const res = await request(app)
      .get('/admin/feature-flags')
      .set('X-Admin-Token', 'wrong');
    expect(res.status).toBe(403);
  });

  it('rejects with 503 when ADMIN_TOKEN matches but firestore is not configured', async () => {
    process.env.ADMIN_TOKEN = 'secret';
    // Override the firestore mock to simulate an unconfigured server.
    jest.doMock('../lib/firestore', () => ({
      firestore: null,
      admin: { firestore: { FieldValue: { serverTimestamp: () => ({}) } } },
    }));
    jest.isolateModules(() => {
      const { router } = require('../lib/admin');
      app = express();
      app.use(express.json());
      app.use(router);
    });
    const res = await request(app)
      .get('/admin/feature-flags')
      .set('X-Admin-Token', 'secret');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Firestore admin not configured/);
  });
});

describe('requireFrozen middleware', () => {
  let originalEnv;
  let originalSettle;
  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    originalSettle = process.env.FREEZE_SETTLE_MS;
    process.env.ADMIN_TOKEN = 'secret';
    process.env.FREEZE_SETTLE_MS = '0';
    jest.resetModules();
  });
  afterEach(() => {
    process.env.ADMIN_TOKEN = originalEnv;
    process.env.FREEZE_SETTLE_MS = originalSettle;
  });

  function buildAppWithFreezeFlag(flagValue) {
    const fakeFlagSnap = {
      exists: flagValue !== undefined,
      data: () => ({ freezeListMembershipWrites: flagValue }),
    };
    const firestoreMock = {
      collection: (name) => {
        if (name === 'configs') {
          return { doc: () => ({ get: async () => fakeFlagSnap }) };
        }
        if (name === 'pins') {
          // Only invoked if requireFrozen passes — return empty.
          return { get: async () => ({ size: 0, forEach: () => {}, docs: [] }) };
        }
        throw new Error(`Unsupported collection: ${name}`);
      },
      getAll: async () => [],
      batch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} }),
    };
    let app;
    jest.isolateModules(() => {
      jest.doMock('../lib/firestore', () => ({
        firestore: firestoreMock,
        admin: { firestore: { FieldValue: { serverTimestamp: () => ({ _ts: true }) } } },
      }));
      const { router } = require('../lib/admin');
      app = express();
      app.use(express.json());
      app.use(router);
    });
    return app;
  }

  it('rejects backfill with 409 when flag is unset', async () => {
    const app = buildAppWithFreezeFlag(undefined);
    const res = await request(app)
      .post('/admin/backfill-list-members')
      .set('X-Admin-Token', 'secret');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/freezeListMembershipWrites=true/);
  });

  it('rejects backfill with 409 when flag is false', async () => {
    const app = buildAppWithFreezeFlag(false);
    const res = await request(app)
      .post('/admin/backfill-list-members')
      .set('X-Admin-Token', 'secret');
    expect(res.status).toBe(409);
  });

  it('proceeds when flag is true', async () => {
    const app = buildAppWithFreezeFlag(true);
    const res = await request(app)
      .post('/admin/backfill-list-members')
      .set('X-Admin-Token', 'secret');
    // Pins collection returns empty, so backfill is a no-op success.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects reconcile with 409 when flag is false', async () => {
    const app = buildAppWithFreezeFlag(false);
    const res = await request(app)
      .post('/admin/reconcile-pin-counts')
      .set('X-Admin-Token', 'secret');
    expect(res.status).toBe(409);
  });

  it('rejects scrub with 409 when flag is false', async () => {
    const app = buildAppWithFreezeFlag(false);
    const res = await request(app)
      .post('/admin/scrub-orphan-members')
      .set('X-Admin-Token', 'secret');
    expect(res.status).toBe(409);
  });
});
