// Tests for the admin-header bypass on /enrich + Bearer regression coverage.
// Exercises authenticateRequest middleware + the slim /enrich handler that
// delegates to claimEnrichmentJob.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

// Spy on verifyIdToken — name MUST start with `mock` for jest hoisting rules.
const mockVerifyIdToken = jest.fn();

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  const baseAdmin = makeAdmin();
  return {
    firestore: getSharedFirestore(),
    admin: {
      ...baseAdmin,
      auth: () => ({ verifyIdToken: (...args) => mockVerifyIdToken(...args) }),
    },
    seedFeatureFlagsPromise: Promise.resolve(),
  };
});

// Spy on runEnrichment — name MUST start with `mock` for jest hoisting rules.
const mockRunEnrichment = jest.fn(() => Promise.resolve());
jest.mock('../enrich', () => ({
  runEnrichment: (...args) => mockRunEnrichment(...args),
}));

const request = require('supertest');
const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');

const fs = getSharedFirestore();
let app;
let originalAdminToken;

const TEST_ADMIN_TOKEN = 'a'.repeat(64);

beforeAll(() => {
  originalAdminToken = process.env.ENRICH_ADMIN_TOKEN;
  process.env.ENRICH_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
});

afterAll(() => {
  if (originalAdminToken === undefined) delete process.env.ENRICH_ADMIN_TOKEN;
  else process.env.ENRICH_ADMIN_TOKEN = originalAdminToken;
});

// Build a minimal express app that mounts ONLY the middleware + /enrich
// handler under test. The middleware impl mirrors index.js exactly (this
// dupe is the cost of not refactoring index.js's listen() out of module-load).
function buildTestApp() {
  const express = require('express');
  const crypto = require('crypto');
  const { admin, firestore } = require('../lib/firestore');
  const { claimEnrichmentJob } = require('../lib/enrichClaim');
  const { runEnrichment } = require('../enrich');

  async function authenticateRequest(req, res, next) {
    const adminTokenHeader = req.headers['x-admin-token'];
    if (typeof adminTokenHeader === 'string' && adminTokenHeader.length > 0) {
      const expected = process.env.ENRICH_ADMIN_TOKEN;
      if (!expected) return res.status(503).json({ error: 'admin path not configured' });
      const provided = Buffer.from(adminTokenHeader);
      const reference = Buffer.from(expected);
      if (provided.length !== reference.length || !crypto.timingSafeEqual(provided, reference)) {
        return res.status(401).json({ error: 'invalid admin token' });
      }
      const bodyUserId = req.body && typeof req.body.userId === 'string' ? req.body.userId : null;
      if (!bodyUserId) return res.status(400).json({ error: 'userId required on admin path' });
      req.authUid = bodyUserId;
      req.adminBypass = true;
      return next();
    }
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    try {
      const decoded = await admin.auth().verifyIdToken(m[1]);
      req.authUid = decoded.uid;
      req.adminBypass = false;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid ID token' });
    }
  }

  const a = express();
  a.use(express.json());
  a.post('/enrich', authenticateRequest, async (req, res) => {
    const { url, userId, captionText, jobId } = req.body || {};
    if (!url || !userId || !jobId) return res.status(400).json({ error: 'url, userId, and jobId are required' });
    if (userId !== req.authUid) return res.status(403).json({ error: 'userId does not match authenticated user' });
    if (!firestore) return res.status(503).json({ error: 'Firestore not configured on server' });
    let result;
    try {
      result = await claimEnrichmentJob(firestore, {
        jobId, userId, url, captionText, adminBypass: !!req.adminBypass,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal error' });
    }
    if (result.shouldEnrich) {
      const args = result.enrichArgs;
      runEnrichment(jobId, args.url, args.userId, args.captionText).catch(() => {});
    }
    return res.status(result.code).json(result.body);
  });
  return a;
}

beforeEach(() => {
  fs.reset();
  mockRunEnrichment.mockClear();
  mockVerifyIdToken.mockReset();
  app = buildTestApp();
});

const USER_ID = 'u_admin_path';
const URL = 'https://www.instagram.com/p/test/';
const JOB_ID = 'job_admin_1';

function seedPending(overrides = {}) {
  fs.seed('enrichmentJobs', JOB_ID, {
    userId: USER_ID,
    url: URL,
    captionText: '',
    status: 'pending',
    createdAt: FakeTimestamp.fromMillis(Date.now() - 1000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 1000),
    ...overrides,
  });
}

describe('/enrich admin-token path', () => {
  test('happy path: valid token + matching userId/url + pending doc → 202 + processing', async () => {
    seedPending();
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: JOB_ID, userId: USER_ID, url: URL, captionText: '' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: JOB_ID, status: 'processing' });
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('cloud_function');
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichment).toHaveBeenCalledWith(JOB_ID, URL, USER_ID, '');
  });

  test('invalid token → 401', async () => {
    seedPending();
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', 'wrong'.repeat(16))
      .send({ jobId: JOB_ID, userId: USER_ID, url: URL });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid admin token/i);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('admin path with no userId in body → 400', async () => {
    seedPending();
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: JOB_ID, url: URL });

    expect(res.status).toBe(400);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('admin path without pre-existing pending doc → 403', async () => {
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: 'nonexistent_job', userId: USER_ID, url: URL });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin bypass requires pre-existing pending doc/i);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('admin path with mismatched userId in body → 403', async () => {
    seedPending();
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: JOB_ID, userId: 'someone_else', url: URL });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin bypass: body does not match stored doc/i);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('admin path with mismatched url in body → 403', async () => {
    seedPending();
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: JOB_ID, userId: USER_ID, url: 'https://different.url/' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin bypass: body does not match stored doc/i);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('admin path with terminal pre-existing doc → 200 returns existing status', async () => {
    seedPending({ status: 'complete' });
    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({ jobId: JOB_ID, userId: USER_ID, url: URL });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobId: JOB_ID, status: 'complete' });
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  test('missing ENRICH_ADMIN_TOKEN env → 503 fail closed', async () => {
    const prev = process.env.ENRICH_ADMIN_TOKEN;
    delete process.env.ENRICH_ADMIN_TOKEN;
    try {
      // Rebuild app so middleware sees the new env state (closure captures process.env each call,
      // but we want to be explicit that the per-test app respects the env at request time).
      app = buildTestApp();
      seedPending();
      const res = await request(app)
        .post('/enrich')
        .set('X-Admin-Token', 'anything')
        .send({ jobId: JOB_ID, userId: USER_ID, url: URL });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/admin path not configured/i);
    } finally {
      process.env.ENRICH_ADMIN_TOKEN = prev;
    }
  });
});

describe('/enrich Bearer path (regression)', () => {
  test('valid Bearer token + matching userId → 202 + processing + triggeredBy=direct_post', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: USER_ID });
    const res = await request(app)
      .post('/enrich')
      .set('Authorization', 'Bearer fake.id.token')
      .send({ jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'hi' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: JOB_ID, status: 'processing' });
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('direct_post');
    expect(doc.userId).toBe(USER_ID);
    expect(doc.url).toBe(URL);
    expect(doc.captionText).toBe('hi');
    expect(mockRunEnrichment).toHaveBeenCalledWith(JOB_ID, URL, USER_ID, 'hi');
  });

  test('Bearer path, userId in body does not match token → 403', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'real_user' });
    const res = await request(app)
      .post('/enrich')
      .set('Authorization', 'Bearer fake.id.token')
      .send({ jobId: JOB_ID, userId: 'impostor', url: URL });

    expect(res.status).toBe(403);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });
});

describe('/enrich Bearer cross-user takeover (Codex P1 regression)', () => {
  test('Bearer userB POSTs with userA-owned pending jobId → 403 + no enrichment', async () => {
    // userA wrote a legitimate pending doc via their own auth.
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: 'userA',
      url: 'https://www.instagram.com/p/aaa/',
      captionText: 'A caption',
      status: 'pending',
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(1000),
    });

    // userB authenticates with their own Bearer token, but tries to claim
    // userA's jobId with userB's own url. (The body must pass userId ===
    // req.authUid, so userB has to use their own userId in the body.)
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'userB' });
    const res = await request(app)
      .post('/enrich')
      .set('Authorization', 'Bearer userB.token')
      .send({
        jobId: JOB_ID,
        userId: 'userB',
        url: 'https://malicious.attacker/',
        captionText: 'attacker-supplied caption',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/does not match stored doc/i);
    expect(mockRunEnrichment).not.toHaveBeenCalled();

    // Doc is unchanged — userA's pending row is intact.
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.userId).toBe('userA');
    expect(doc.url).toBe('https://www.instagram.com/p/aaa/');
    expect(doc.status).toBe('pending');
    expect(doc.captionText).toBe('A caption');
  });
});

describe('/enrich body-takeover prevention on pre-existing doc (Codex P2 regression)', () => {
  test('admin path: stored captionText is passed to runEnrichment, NOT body captionText', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID,
      url: URL,
      captionText: 'the real caption the user shared',
      status: 'pending',
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(1000),
    });

    const res = await request(app)
      .post('/enrich')
      .set('X-Admin-Token', TEST_ADMIN_TOKEN)
      .send({
        jobId: JOB_ID,
        userId: USER_ID,
        url: URL,
        captionText: 'attacker-substituted caption that should be ignored',
      });

    expect(res.status).toBe(202);
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichment).toHaveBeenCalledWith(
      JOB_ID,
      URL,
      USER_ID,
      'the real caption the user shared',
    );
  });

  test('Bearer same-user path: stored captionText also wins (defense in depth)', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID,
      url: URL,
      captionText: 'original at write-time',
      status: 'pending',
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(1000),
    });

    mockVerifyIdToken.mockResolvedValueOnce({ uid: USER_ID });
    const res = await request(app)
      .post('/enrich')
      .set('Authorization', 'Bearer user.token')
      .send({
        jobId: JOB_ID,
        userId: USER_ID,
        url: URL,
        captionText: 'client buggily re-derived a different caption',
      });

    expect(res.status).toBe(202);
    expect(mockRunEnrichment).toHaveBeenCalledWith(
      JOB_ID,
      URL,
      USER_ID,
      'original at write-time',
    );
  });
});
