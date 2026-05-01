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

  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    jest.resetModules();
  });

  afterEach(() => {
    process.env.ADMIN_TOKEN = originalEnv;
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
