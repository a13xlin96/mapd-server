// Independent F2/F3 review. These use real coordination and real registered
// HTTP handlers; external providers/storage are local stubs. All acceptance
// assertions are ordinary regression tests after the implementation fixes.
jest.mock('../lib/firestore', () => {
  const {getSharedFirestore, makeAdmin} = require('./helpers/fakeFirestore');
  return {firestore: getSharedFirestore(), admin: {...makeAdmin(), auth: () => ({verifyIdToken: async token => ({uid: token})})},
    seedFeatureFlagsPromise: Promise.resolve()};
});
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(async () => null), setCache: jest.fn(async () => {})}));
jest.mock('../lib/enrichmentWorker', () => ({createWorker: () => ({nudge: jest.fn(), start: jest.fn()})}));
jest.mock('../lib/enrichmentSweeper', () => ({}));
jest.mock('../lib/admin', () => ({router: require('express').Router()}));
jest.mock('../lib/listMembership', () => ({router: require('express').Router()}));
jest.mock('../lib/interestProfile', () => ({interestProfileRouter: require('express').Router(), recordPinSaved: jest.fn(async () => {})}));
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn()}));
jest.mock('../lib/anthropic', () => ({anthropic: {messages: {create: jest.fn()}}}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(async value => value),
  downloadImage: jest.fn(async () => ({bytes: Buffer.from('review-image'), contentType: 'image/jpeg'}))}));
jest.mock('../lib/extraction', () => ({extractPublicPost: jest.fn(async () => ({title: 'Public Cafe', description: 'Public Cafe in Kyoto'}))}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation: () => ({id: 'review-observation',
  markDispatched: async () => {}, settle: async () => {}, releaseUnsent: async () => {}})}));

const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createSharedAiOperations, SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {createSharedAiStore, COLLECTION} = require('../lib/sharedAiStore');
const {identity} = require('../lib/sharedAiIdentity');
const {createCooldownStore} = require('../lib/providerCooldown');
const jobContext = require('../lib/jobContext');
const {EngineError} = require('../lib/engineError');
const {app} = require('../index');
const {anthropic} = require('../lib/anthropic');
const request = require('supertest');
const gate = () => { let resolve; return {promise: new Promise(r => { resolve = r; }), release: value => resolve(value)}; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await wait(2); expect(predicate()).toBeTruthy(); }
const config = extra => ({kind: 'independent-review', input: {text: 'evidence'}, scope: 'user:review',
  model: 'review-model', promptVersion: '1', schemaVersion: 1, optionsVersion: '1',
  validate: value => typeof value?.answer === 'string', ...extra});
const good = {answer: 'venue'};
const cache = () => ({getCached: async () => null, setCache: async () => {}});
const coordinator = (db, extra = {}) => createSharedAiOperations({firestore: db, cache: cache(), limits: {pollMs: 5}, ...extra});
const dispatch = fn => async ({sharedOperation}) => { await sharedOperation.authorizeDispatch(); return fn(); };

beforeEach(() => jest.clearAllMocks());

test('[P1] cancelling the final subscriber before dispatch must stop paid work', async () => {
  const db = new FakeFirestore(), shared = coordinator(db), held = gate(), entered = gate();
  const controller = new AbortController(), provider = jest.fn(() => good);
  const pending = jobContext.run({userId: 'review', signal: controller.signal}, () => shared.runSharedAiOperation(config(), async ({sharedOperation}) => {
    entered.release(); await held.promise;
    await sharedOperation.authorizeDispatch();
    return provider();
  }));
  const cancelled = expect(pending).rejects.toMatchObject({code: 'attempt_stopped'});
  await entered.promise; controller.abort(); await cancelled;
  held.release(); await until(() => shared.activeCount() === 0);
  expect(provider).not.toHaveBeenCalled();
});

test('cancelling one caller must preserve work still needed by another', async () => {
  const db = new FakeFirestore(), shared = coordinator(db), held = gate(), entered = gate();
  const controller = new AbortController(), provider = jest.fn(() => good);
  const work = async ({sharedOperation}) => { entered.release(); await held.promise; await sharedOperation.authorizeDispatch(); return provider(); };
  const first = jobContext.run({signal: controller.signal}, () => shared.runSharedAiOperation(config(), work));
  const cancelled = expect(first).rejects.toMatchObject({code: 'attempt_stopped'});
  const second = shared.runSharedAiOperation(config(), work);
  await entered.promise; controller.abort(); await cancelled; held.release();
  expect(await second).toEqual(good); expect(provider).toHaveBeenCalledTimes(1);
});

test('[P1] simultaneous refreshes waiting behind normal work must reuse the same fresh generation', async () => {
  const db = new FakeFirestore(), slowObservedNormal = gate(), resumeSlow = gate();
  // Delay one process's read of the just-completed NORMAL generation until
  // the other process has already completed the REFRESH generation.
  const slowDb = {runTransaction: callback => db.runTransaction(callback), collection: name => ({doc: id => {
    const ref = db.collection(name).doc(id), get = ref.get.bind(ref);
    ref.get = async () => {
      const snap = await get();
      if (id.endsWith('_1') && snap.data()?.state === 'complete') {
        slowObservedNormal.release(); await resumeSlow.promise;
      }
      return snap;
    };
    return ref;
  }})};
  const fast = coordinator(db), slow = coordinator(slowDb), holdNormal = gate();
  const normal = fast.runSharedAiOperation(config(), dispatch(() => holdNormal.promise));
  await until(() => fast.stats.leaders === 1);
  const freshProvider = jest.fn(() => ({answer: 'fresh'}));
  const one = fast.runSharedAiOperation(config({bypassCache: true}), dispatch(freshProvider));
  const two = slow.runSharedAiOperation(config({bypassCache: true}), dispatch(freshProvider));
  await until(() => fast.stats.followers === 1 && slow.stats.followers === 1);
  holdNormal.release(good); await normal; await one; await slowObservedNormal.promise;
  resumeSlow.release(); await two;
  expect(freshProvider).toHaveBeenCalledTimes(1);
  expect(db.read(COLLECTION, identity(config()).key).generation).toBe(2);
});

test('[P1] legacy verify handler must return a response for malformed input instead of rejecting into Express 4', async () => {
  const layer = app._router.stack.find(item => item.route?.path === '/ai/verify-place');
  const handler = layer.route.stack.at(-1).handle;
  const res = {json: jest.fn(), status: jest.fn(function () { return this; })};
  // Invoke the actual registered handler and consume its rejection in the test:
  // Express 4 itself does not consume returned promises, so an HTTP-only test
  // would leak an unhandled rejection/hung request into the Jest process.
  await expect(handler({authUid: 'review', body: {description: {}, placeName: 'Cafe'}}, res)).resolves.toBeUndefined();
  expect(res.json).toHaveBeenCalled();
  expect(anthropic.messages.create).not.toHaveBeenCalled();
});

test('legacy real HTTP routes reject unauthenticated work and use the verified UID despite forged body scope', async () => {
  const engineAI = require('../enrich/ai');
  const spy = jest.spyOn(engineAI, 'aiExtractPlaces').mockImplementation(async (_input, options) => ({
    scope: options.scope, owner: jobContext.current().userId,
  }));
  const server = require('http').createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    expect((await request(server).post('/ai/extract-places').send({description: 'private'})).status).toBe(401);
    const result = await request(server).post('/ai/extract-places').set('Authorization', 'Bearer verified').send({
      description: 'private', scope: 'public', userId: 'victim', verifiedUID: 'victim', attemptId: 'forged',
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({scope: 'user:verified', owner: 'verified'});
  } finally { spy.mockRestore(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});

test('private/public scopes cannot alias, and changed model/options/image order changes identity', () => {
  const base = {images: [{digest: 'a'}, {digest: 'b'}]};
  const variants = [
    {scope: 'user:a'}, {scope: 'user:b'}, {scope: SERVER_PUBLIC_SCOPE},
    {scope: 'public'}, {scope: 'public'}, {scope: undefined},
    {scope: 'user:a', model: 'new-model'}, {scope: 'user:a', optionsVersion: '2'},
    {scope: 'user:a', input: {images: [...base.images].reverse()}},
  ];
  expect(new Set(variants.map(extra => identity(config({input: base, ...extra})).key)).size).toBe(variants.length);
});

test('expired pre-dispatch owner cannot dispatch or publish after replacement, while uncertain dispatch cannot auto-respend', async () => {
  const db = new FakeFirestore(); let now = 1000;
  const store = createSharedAiStore({firestore: db, now: () => now});
  const claim = extra => store.claim({key: 'review', refresh: false, leaseMs: 10, timeoutMs: 100,
    subscription:{id:'review-process',expiresAt:()=>now+100}, ...extra});
  const a = await claim(); now += 11; const b = await claim();
  await expect(store.authorizeDispatch('review', a.record)).rejects.toMatchObject({code: 'attempt_stopped'});
  await expect(store.publish('review', a.record, {result: good, ttlMs: 100})).rejects.toMatchObject({code: 'attempt_stopped'});
  await store.authorizeDispatch('review', b.record); now += 101;
  const c = await claim();
  expect(c.leader).toBe(false); expect(c.record.state).toBe('uncertain');
  now += 100000;
  expect((await claim()).leader).toBe(false);
  const explicit = await claim({refresh: true}); expect(explicit.leader).toBe(true);
});

test('cooldown persistence failure keeps fresh work closed; shorter/expired windows never schedule replay', async () => {
  let now = 1000;
  const local = createCooldownStore({now: () => now, allowLocal: true});
  await local.recordCooldown('review', {code: 'rate_limited', retryAfterSeconds: 300});
  await local.recordCooldown('review', {code: 'rate_limited', retryAfterSeconds: 1});
  expect(await local.cooldownRemaining('review')).toBe(300);
  now += 300001; expect(await local.cooldownRemaining('review')).toBe(0);
  const down = createCooldownStore({redis: {eval: async () => { throw new Error('down'); }}, allowLocal: true});
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(down.recordCooldown('review', {code: 'rate_limited', retryAfterSeconds: 5})).rejects.toMatchObject({code: 'dependency_error'});
    await expect(down.cooldownRemaining('review')).rejects.toMatchObject({code: 'dependency_error'});
  } finally { warning.mockRestore(); }
});
