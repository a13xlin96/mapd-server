'use strict';
// Directly invoke the actual registered HTTP handler; no listening socket.
jest.mock('../lib/firestore', () => {
  const {getSharedFirestore, makeAdmin} = require('./helpers/fakeFirestore');
  return {firestore: getSharedFirestore(), admin: makeAdmin(), seedFeatureFlagsPromise: Promise.resolve()};
});
jest.mock('../lib/cache', () => ({redis: null, getCached: async () => null, setCache: async () => {}}));
jest.mock('../lib/anthropic', () => ({anthropic: {messages: {create: jest.fn()}}}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(), downloadImage: jest.fn()}));
jest.mock('axios', () => ({get: jest.fn(), post: jest.fn()}));
jest.mock('../lib/enrichmentWorker', () => ({createWorker: () => ({nudge: jest.fn(), start: jest.fn()})}));
jest.mock('../lib/pinDetailsWorker', () => ({createPinDetailsWorker: () => ({nudge: jest.fn(), start: jest.fn()})}));
jest.mock('../lib/enrichmentSweeper', () => ({}));
jest.mock('../lib/admin', () => ({router: require('express').Router()}));
jest.mock('../lib/listMembership', () => ({router: require('express').Router()}));
jest.mock('../lib/interestProfile', () => ({interestProfileRouter: require('express').Router(), recordPinSaved: jest.fn()}));
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn()}));
jest.mock('../enrich', () => ({runEnrichment: jest.fn(), saveSelectedPlaces: jest.fn()}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation: () => ({id: 'review-observation',
  markDispatched: async () => {}, settle: async () => {}, releaseUnsent: async () => {}})}));

let now = Date.now();
const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
const {app} = require('../index');
const jobContext = require('../lib/jobContext');
const {anthropic} = require('../lib/anthropic');
const {firestore} = require('../lib/firestore');
afterAll(() => clock.mockRestore());

const route = '/ai/infer-place-regions';
function requestFor(name = 'Cafe', uid = 'retry-user', retryGeneration) {
  return {authUid: uid, body: {places: [{name, url: ''}], listName: 'Kyoto', siblingPlaces: [],
    ...(retryGeneration === undefined ? {} : {retryGeneration})}};
}
async function invoke(req) {
  const handler = app._router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle;
  const res = {statusCode: 200, body: null, status(code) {this.statusCode = code; return this;}, json(body) {this.body = body; return this;}};
  await jobContext.run({userId: req.authUid, attemptId: `http-test-${now}`, deadline: now + 120000}, () => handler(req, res));
  return res;
}
function success(name = 'Cafe') {
  return {stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({results: [{name, city: 'Kyoto', country: 'Japan', confidence: 'high'}]})}]};
}
beforeEach(() => {
  firestore.reset(); anthropic.messages.create.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

test('failed responses require explicit retry; repeated generation tokens reuse one successor', async () => {
  anthropic.messages.create.mockRejectedValueOnce(Object.assign(new Error('unavailable'), {status:503}));
  const first = await invoke(requestFor());
  expect(first.statusCode).toBe(502);
  const generation = first.body.failure.retryGeneration;
  expect(generation).toBe(1);
  now += 86400000;
  anthropic.messages.create.mockResolvedValue(success());
  const automatic = await invoke(requestFor());
  expect(automatic.statusCode).toBe(502);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  const userRetry = await invoke(requestFor('Cafe', 'retry-user', generation));
  expect(userRetry.statusCode).toBe(200);
  expect((await invoke(requestFor('Cafe', 'retry-user', generation))).statusCode).toBe(200);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
});

test('repeated delivery of a failed retry cannot charge again; its new token allows a new user action', async () => {
  anthropic.messages.create.mockRejectedValue(Object.assign(new Error('unavailable'), {status:503}));
  const first = await invoke(requestFor('Retry cafe'));
  const second = await invoke(requestFor('Retry cafe', 'retry-user', first.body.failure.retryGeneration));
  expect(second.body.failure.retryGeneration).toBe(2);
  expect((await invoke(requestFor('Retry cafe', 'retry-user', 1))).body.failure.retryGeneration).toBe(2);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
  anthropic.messages.create.mockResolvedValue(success('Retry cafe'));
  expect((await invoke(requestFor('Retry cafe', 'retry-user', 2))).statusCode).toBe(200);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
});

test('retry tokens are bound to the input and verified account, not a caller-supplied scope', async () => {
  anthropic.messages.create.mockRejectedValueOnce(Object.assign(new Error('unavailable'), {status:503}));
  await invoke(requestFor('Private cafe'));
  for (const req of [requestFor('Different input','retry-user',1), requestFor('Private cafe','other-user',1)]) {
    req.body.scope = 'user:retry-user';
    expect((await invoke(req)).statusCode).toBe(502);
  }
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});

test.each([0,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1])('invalid retry token %p is rejected before paid work', async token => {
  expect((await invoke(requestFor('Invalid','retry-user',token))).body.failure.code).toBe('invalid_response');
  expect(anthropic.messages.create).not.toHaveBeenCalled();
});

test('a successful result cannot be used as a paid retry anchor', async () => {
  anthropic.messages.create.mockResolvedValue(success('Done'));
  expect((await invoke(requestFor('Done'))).statusCode).toBe(200);
  expect((await invoke(requestFor('Done','retry-user',1))).statusCode).toBe(502);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});
