jest.mock('../lib/firestore', () => {
  const {getSharedFirestore, makeAdmin} = require('./helpers/fakeFirestore');
  return {firestore: getSharedFirestore(), admin: {...makeAdmin(), auth: () => ({verifyIdToken: async token => {
    if (!['owner', 'attacker'].includes(token)) throw new Error('invalid fixture token');
    return {uid: token};
  }})}, seedFeatureFlagsPromise: Promise.resolve()};
});
jest.mock('../lib/enrichmentWorker', () => ({createWorker: () => ({nudge: jest.fn(), start: jest.fn()})}));
jest.mock('../lib/enrichmentSweeper', () => ({}));
jest.mock('../lib/admin', () => ({router: require('express').Router()}));
jest.mock('../lib/listMembership', () => ({router: require('express').Router()}));
jest.mock('../lib/interestProfile', () => ({interestProfileRouter: require('express').Router(), recordPinSaved: jest.fn(async () => {})}));
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn()}));
jest.mock('../lib/anthropic', () => ({anthropic: {messages: {create: jest.fn()}}}));
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(async () => null), setCache: jest.fn(async () => {})}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(async image => image)}));
jest.mock('../lib/extraction', () => ({extractPublicPost: jest.fn()}));
jest.mock('axios', () => ({get: jest.fn(() => {throw new Error('External HTTP forbidden in retry tests');})}));
const request = require('supertest');
const {app} = require('../index');
const {firestore: db, admin} = require('../lib/firestore');
const {enqueueNewPin, createPinDetails} = require('../lib/pinDetails');
const context = require('../lib/jobContext');
const route = '/pins/pin/details/retry';
let clock, service, fetchDetails;
const storedTask = () => db.read('pinDetailTasks', 'pin');
async function seed(placeId = 'place') {
  const ref = db.collection('pins').doc('pin');
  const pin = {userId: 'owner', placeId, detailsSchemaVersion: 1, detailsState: 'pending', detailsRevision: 1};
  await db.runTransaction(async txn => {txn.set(ref, pin); enqueueNewPin(txn, db, admin, ref, pin);});
  fetchDetails.mockRejectedValueOnce(new Error('fixture optional-details failure'));
  await service.process('pin');
}
const post = (body = {revision: 1}, token = 'owner') => request(app).post(route)
  .set('Authorization', `Bearer ${token}`).send({taskId: storedTask()?.taskId, ...body});
beforeEach(async () => {
  db.reset(); clock = Date.now(); db.setNow(() => clock); db.strictReadOrder = true;
  db.seed('users', 'owner', {}); db.seed('users', 'attacker', {});
  fetchDetails = jest.fn(async () => {await context.current().beforeProviderDispatch(); return {types: ['cafe'], rating: 4.6};});
  service = createPinDetails({db, admin, fetchDetails, now: () => clock}); await seed();
});
afterEach(() => {db.strictReadOrder = false; jest.restoreAllMocks();});

test.each(['missing', 'invalid'])('actual retry endpoint refuses %s authentication before changing a task', async mode => {
  const req = request(app).post(route);
  if (mode === 'invalid') req.set('Authorization', 'Bearer invalid');
  const response = await req.send({revision: 1, userId: 'owner'});
  expect(response.status).toBe(401); expect(storedTask()).toMatchObject({status: 'needs_action', revision: 1});
});

test('verified request UID wins over a forged owner in the request body', async () => {
  const response = await post({revision: 1, userId: 'owner'}, 'attacker');
  expect(response.status).toBe(403); expect(response.body.failure.code).toBe('access_blocked');
  expect(storedTask()).toMatchObject({status: 'needs_action', revision: 1});
});

test.each([null, '1', 0, -1, 1.5, 9007199254740992])('actual retry endpoint rejects invalid revision %p', async revision => {
  const response = await post({revision});
  expect(response.status).toBe(422); expect(response.body.failure.code).toBe('invalid_response');
  expect(storedTask()).toMatchObject({status: 'needs_action', revision: 1});
});

test('parallel HTTP retries and repeated response delivery authorize one additional attempt', async () => {
  const responses = await Promise.all(Array.from({length: 4}, () => post()));
  for (const response of responses) {expect(response.status).toBe(200); expect(response.body).toEqual({status: 'queued', revision: 2});}
  await service.process('pin');
  expect((await post()).body).toEqual({status: 'complete', revision: 2});
  expect(fetchDetails).toHaveBeenCalledTimes(2);
});

test('client-provided place, generation and billable mask cannot override server task authority', async () => {
  const response = await post({revision: 1, placeId: 'attacker-place', fieldMask: '*', pinGeneration: 'invented', userId: 'attacker'});
  expect(response.status).toBe(200); expect(storedTask()).toMatchObject({placeId: 'place', userId: 'owner', revision: 2});
  expect(storedTask().pinGeneration).toBe(String(clock));
  await service.process('pin'); expect(fetchDetails.mock.calls[1][0]).toBe('place');
});

test('a forged task token is forbidden even for the authenticated pin owner', async () => {
  const original = storedTask();
  const response = await post({revision: 1, taskId: 'forged-task-id'});
  expect(response.status).toBe(403); expect(response.body.failure.code).toBe('access_blocked');
  expect(storedTask()).toEqual(original); expect(fetchDetails).toHaveBeenCalledTimes(1);
});

test('missing task token is rejected without queuing work', async () => {
  const response = await request(app).post(route).set('Authorization', 'Bearer owner').send({revision: 1});
  expect(response.status).toBe(422); expect(response.body.failure.code).toBe('invalid_response');
  expect(storedTask()).toMatchObject({status: 'needs_action', revision: 1});
});

test.each(['pin', 'account', 'task'])('retry cannot recreate a deleted %s', async kind => {
  const body = {revision: 1, taskId: storedTask().taskId};
  const collection = kind === 'pin' ? 'pins' : kind === 'account' ? 'users' : 'pinDetailTasks';
  await db.collection(collection).doc(kind === 'account' ? 'owner' : 'pin').delete();
  const response = await post(body); expect(response.status).toBe(403);
  expect(db.read(collection, kind === 'account' ? 'owner' : 'pin')).toBeUndefined();
});

test('REGRESSION: delayed HTTP retry from an old pin generation cannot retry its replacement', async () => {
  const oldGeneration = storedTask().pinGeneration;
  const delayedBody = {revision: 1, taskId: storedTask().taskId};
  await db.collection('pins').doc('pin').delete(); await db.collection('pinDetailTasks').doc('pin').delete();
  clock += 100; await seed('replacement-place');
  expect(storedTask().pinGeneration).not.toBe(oldGeneration);
  expect(storedTask().taskId).not.toBe(delayedBody.taskId);
  expect(storedTask()).toMatchObject({placeId: 'replacement-place', status: 'needs_action', revision: 1});
  const response = await post(delayedBody);
  expect(response.status).toBe(403); expect(response.body.failure.code).toBe('access_blocked');
  expect(storedTask()).toMatchObject({placeId: 'replacement-place', status: 'needs_action', revision: 1});
});
