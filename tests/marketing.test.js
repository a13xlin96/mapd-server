// Marketing surface: /go redirector, /waitlist capture, /get landing page.
// Firestore is mocked so we assert on the calls without hitting the network.

const express = require('express');
const request = require('supertest');

const mockAdd = jest.fn(() => Promise.resolve());
const mockSet = jest.fn(() => Promise.resolve());
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ add: mockAdd, doc: mockDoc }));

jest.mock('../lib/firestore', () => ({
  firestore: { collection: (...a) => mockCollection(...a) },
  admin: { firestore: { FieldValue: { serverTimestamp: () => ({ _ts: true }) } } },
}));

// Build a fresh app with the marketing router, picking up current env vars
// (the module reads install-URL env at load time).
function buildApp() {
  let app;
  jest.isolateModules(() => {
    const { router } = require('../lib/marketing');
    app = express();
    app.use(express.json());
    app.use(router);
  });
  return app;
}

const ENV_KEYS = ['IOS_INSTALL_URL', 'ANDROID_INSTALL_URL', 'PUBLIC_BASE_URL', 'OG_IMAGE_URL'];
let savedEnv;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('/go/:campaign tracked redirector', () => {
  it('logs a click to marketingClicks and falls back to the waitlist when stores are not live', async () => {
    const res = await request(buildApp()).get('/go/tiktok-foodie-nyc7?utm_source=tiktok');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/get');
    expect(res.headers.location).toContain('ref=tiktok-foodie-nyc7');
    expect(mockCollection).toHaveBeenCalledWith('marketingClicks');
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: 'tiktok-foodie-nyc7', type: 'go', utm_source: 'tiktok' }),
    );
  });

  it('redirects iOS devices to the iOS install URL once configured', async () => {
    process.env.IOS_INSTALL_URL = 'https://testflight.apple.com/join/abc123';
    const res = await request(buildApp())
      .get('/go/x')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://testflight.apple.com/join/abc123');
  });

  it('redirects Android devices to the Android install URL once configured', async () => {
    process.env.ANDROID_INSTALL_URL = 'https://play.google.com/store/apps/details?id=com.mapd.app';
    const res = await request(buildApp())
      .get('/go/x')
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14)');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://play.google.com/store/apps/details?id=com.mapd.app');
  });
});

describe('POST /waitlist', () => {
  it('rejects an invalid email with 400 and does not write', async () => {
    const res = await request(buildApp()).post('/waitlist').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('accepts a valid email and writes a deduped doc', async () => {
    const res = await request(buildApp())
      .post('/waitlist')
      .send({ email: 'Test@Example.com ', ref: 'tiktok-foodie-nyc7', utm_source: 'tiktok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockCollection).toHaveBeenCalledWith('waitlist');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'test@example.com', ref: 'tiktok-foodie-nyc7', utm_source: 'tiktok' }),
      { merge: true },
    );
  });
});

describe('GET /get landing page', () => {
  it('renders the waitlist page', async () => {
    const res = await request(buildApp()).get('/get?ref=tiktok-foodie-nyc7');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Join the beta');
    expect(res.text).toContain('Mapd');
    expect(mockCollection).toHaveBeenCalledWith('marketingClicks');
  });
});
