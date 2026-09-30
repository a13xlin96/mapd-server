jest.mock('../lib/firestore', () => ({admin: {auth: () => ({verifyIdToken: async token => {
  if (!['owner', 'attacker'].includes(token)) throw new Error('invalid test token');
  return {uid: token};
}})}}));
const express = require('express');
const request = require('supertest');
const {FakeFirestore} = require('./helpers/fakeFirestore');
const {authenticateRequest} = require('../lib/auth');
const {registerDetectionReviewRoute} = require('../lib/detectionReviewRoutes');
const {RECOVERY} = require('../lib/media/analysisRecovery');
const db = new FakeFirestore(), app = express();
app.use(express.json());
registerDetectionReviewRoute(app, {db, authenticateRequest, apiLimiter: (_req, _res, next) => next()});
const route = '/enrich/review';
const post = (body = {jobId: 'job'}, token = 'owner') => request(app).post(route).set('Authorization', `Bearer ${token}`).send(body);
const mutation = p => ({jobId: 'job', version: p.version, decisions: [{outcomeId: p.items[0].outcomeId, action: 'same_place', savedPlaceId: 'place'}]});
let adminToken;
beforeEach(() => {
  adminToken = process.env.ENRICH_ADMIN_TOKEN; process.env.ENRICH_ADMIN_TOKEN = 'test-admin-secret';
  db.reset(); db.strictReadOrder = true;
  db.seed('pins', 'pin', {userId: 'owner', placeId: 'place', placeName: 'Cafe', city: 'NYC', formattedAddress: '1 Main St'});
  db.seed('enrichmentJobs', 'job', {userId: 'owner', engineVersion: {schema: 2}, status: 'failed', failure: {code: 'partial_save'},
    analysisRecovery: RECOVERY, outcomes: [{status: 'saved', name: 'Cafe', placeId: 'place', pinId: 'pin'},
      {status: 'unresolved', name: 'Cafe', city: 'Paris', ranking: {candidates: [{placeId: 'place'}]}}]});
});
afterEach(() => {if (adminToken === undefined) delete process.env.ENRICH_ADMIN_TOKEN; else process.env.ENRICH_ADMIN_TOKEN = adminToken; jest.restoreAllMocks();});

test.each(['missing', 'invalid'])('%s user authentication fails before any storage access', async kind => {
  const txn = jest.spyOn(db, 'runTransaction');
  const req = request(app).post(route); if (kind === 'invalid') req.set('Authorization', 'Bearer invalid');
  expect((await req.send({jobId: 'job'})).status).toBe(401); expect(txn).not.toHaveBeenCalled();
});

test.each([false, true])('operator bypass is forbidden, with real bearer present=%s', async bearer => {
  const txn = jest.spyOn(db, 'runTransaction'), req = request(app).post(route).set('X-Admin-Token', 'test-admin-secret');
  if (bearer) req.set('Authorization', 'Bearer owner');
  const response = await req.send({jobId: 'job', userId: 'owner'});
  expect(response.status).toBe(403); expect(response.body).toEqual({error: 'access_blocked'}); expect(txn).not.toHaveBeenCalled();
});

test('cross-user preview and mutation are forbidden and never echo job data', async () => {
  const p = (await post()).body;
  for (const body of [{jobId: 'job'}, mutation(p)]) {
    const response = await post(body, 'attacker'); expect(response.status).toBe(403); expect(response.body).toEqual({error: 'access_blocked'});
  }
});

test('forged body identity cannot override verified auth', async () => {
  const response = await post({jobId: 'job', userId: 'owner'}, 'attacker');
  expect(response.status).toBe(400); expect(db.read('enrichmentJobs', 'job').outcomes[1].status).toBe('unresolved');
});

test('preview and repeated double taps return the complete sanitized recovery-aware contract', async () => {
  const response = await post(); expect(response.status).toBe(200); const body = mutation(response.body);
  expect(Object.keys(response.body).sort()).toEqual(['version', 'revision', 'savedCount', 'unresolvedCount', 'completed', 'analysisRecovery', 'items'].sort());
  expect(response.body.revision).toBe(0);
  const results = await Promise.all([post(body), post(body), post(body)]);
  for (const result of results) {
    expect(result.status).toBe(200); expect(result.body).toEqual(results[0].body);
    expect(result.body).toMatchObject({revision: 1, completed: true, savedCount: 1, unresolvedCount: 0, analysisRecovery: RECOVERY, items: []});
  }
});

test('stale mutation returns stable 409 and client can reload a fresh read-only preview', async () => {
  const p = (await post()).body;
  await db.collection('pins').doc('pin').update({formattedAddress: '2 Changed Address'});
  const result = await post(mutation(p)); expect(result.status).toBe(409); expect(result.body).toEqual({error: 'review_conflict'});
  const next = await post(); expect(next.status).toBe(200); expect(next.body.version).not.toBe(p.version);
  expect(next.body.items[0].savedPlace.address).toBe('2 Changed Address');
  expect(db.read('enrichmentJobs', 'job').status).toBe('failed');
});

test('invalid decision is stable 400; infrastructure failure is stable 503 without raw text', async () => {
  const body = mutation((await post()).body); body.decisions[0].savedPlaceId = 'forged';
  expect((await post(body)).status).toBe(400);
  jest.spyOn(db, 'runTransaction').mockRejectedValue(new Error('provider secret private diagnostics'));
  const response = await post(); expect(response.status).toBe(503); expect(response.body).toEqual({error: 'review_unavailable'});
});

test('unavailable database and missing authenticated UID fail closed', async () => {
  const unavailable = express(); unavailable.use(express.json());
  registerDetectionReviewRoute(unavailable, {db: null, authenticateRequest, apiLimiter: (_r, _s, next) => next()});
  const response = await request(unavailable).post(route).set('Authorization', 'Bearer owner').send({jobId: 'job'});
  expect(response.status).toBe(503); expect(response.body).toEqual({error: 'review_unavailable'});
  const noUid = express(); noUid.use(express.json());
  registerDetectionReviewRoute(noUid, {db, authenticateRequest: (_r, _s, next) => next(), apiLimiter: (_r, _s, next) => next()});
  expect((await request(noUid).post(route).send({jobId: 'job'})).status).toBe(403);
});
