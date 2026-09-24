jest.mock('../lib/firestore', () => {
  const {getSharedFirestore, makeAdmin} = require('./helpers/fakeFirestore');
  return {firestore: getSharedFirestore(), admin: makeAdmin()};
});
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn()}));
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(async () => null), setCache: jest.fn(async () => {})}));
jest.mock('../lib/anthropic', () => ({anthropic: {messages: {create: jest.fn()}}}));
const {firestore: db, admin} = require('../lib/firestore');
const {createPinDetails, enqueueNewPin} = require('../lib/pinDetails');
const {createPinDetailsWorker} = require('../lib/pinDetailsWorker');
const context = require('../lib/jobContext');
const {EngineError} = require('../lib/engineError');

let clock, fetchDetails, service;
const pin = (patch = {}) => ({userId: 'owner', placeId: 'place', category: 'other', city: null, country: null,
  detailsSchemaVersion: 1, detailsState: 'pending', detailsRevision: 1, ...patch});
const result = (patch = {}) => ({name: 'Provider Cafe', types: ['cafe'], rating: 4.7,
  address_components: [{long_name: 'Kyoto', types: ['locality']}, {long_name: 'Japan', types: ['country']}], ...patch});
const task = (id = 'pin') => db.read('pinDetailTasks', id);
const stored = (id = 'pin') => db.read('pins', id);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
async function seed(id = 'pin', patch = {}) {
  const ref = db.collection('pins').doc(id), value = pin(patch);
  await db.runTransaction(async txn => { txn.set(ref, value); enqueueNewPin(txn, db, admin, ref, value); });
}
beforeEach(() => {
  db.reset(); clock = Date.now(); db.setNow(() => clock); db.strictReadOrder = true;
  db.seed('users', 'owner', {});
  // Exercise task fencing independently of the not-yet-integrated runtime hook.
  fetchDetails = jest.fn(async () => { await context.current().beforeProviderDispatch(); return result(); });
  service = createPinDetails({db, admin, fetchDetails, now: () => clock});
});
afterEach(() => { jest.restoreAllMocks(); db.strictReadOrder = false; });

test('a newly constructed worker discovers a committed queued task after a process restart', async () => {
  await seed();
  const restarted = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
  await restarted.tick(); await restarted.stop();
  expect(task().status).toBe('complete'); expect(fetchDetails).toHaveBeenCalledTimes(1);
});

test.each([true, false])('restart expires abandoned running work, dispatched=%s, without another provider call', async dispatched => {
  await seed();
  await db.collection('pinDetailTasks').doc('pin').update({status: 'running', pinGeneration: String(clock),
    owner: 'dead-process', deadline: clock - 1, dispatched});
  const restarted = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
  await restarted.tick(); await restarted.tick(); await restarted.stop();
  expect(task().status).toBe('needs_action'); expect(stored().detailsState).toBe('needs_action');
  expect(fetchDetails).not.toHaveBeenCalled();
});

test('two worker instances and concurrent ticks have one task owner and one dispatch', async () => {
  await seed();
  const one = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
  const two = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
  await Promise.all([one.tick(), one.tick(), two.tick()]);
  await one.stop(); await two.stop();
  expect(fetchDetails).toHaveBeenCalledTimes(1); expect(task().status).toBe('complete');
});

test('stopped worker leaves queued work for another worker', async () => {
  await seed(); const worker = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
  await worker.stop(); await worker.tick();
  expect(fetchDetails).not.toHaveBeenCalled(); expect(task().status).toBe('queued');
});

test('authorization rereads deletion after claim and refuses physical dispatch', async () => {
  await seed(); let physicalCalls = 0;
  fetchDetails.mockImplementation(async () => {
    await db.collection('pins').doc('pin').delete();
    await context.current().beforeProviderDispatch(); physicalCalls++; return result();
  });
  expect(await service.process('pin')).toBe('cancelled'); expect(physicalCalls).toBe(0);
  expect(stored()).toBeUndefined();
});

test('duplicate dispatch authorization is refused within one task revision', async () => {
  await seed();
  fetchDetails.mockImplementation(async () => {
    const authorize = context.current().beforeProviderDispatch;
    await authorize(); await expect(authorize()).rejects.toMatchObject({code: 'attempt_stopped'});
    return result();
  });
  expect(await service.process('pin')).toBe('complete'); expect(task().dispatched).toBe(true);
});

test('expired producer cannot overwrite a successful explicit retry', async () => {
  await seed(); const started = deferred(), oldResult = deferred();
  fetchDetails.mockImplementationOnce(async () => {
    await context.current().beforeProviderDispatch(); started.resolve(); return oldResult.promise;
  });
  const old = service.process('pin'); await started.promise;
  clock += 50000; await service.expire('pin');
  expect(await service.retry('pin', 'owner', 1, task().taskId)).toEqual({status: 'queued', revision: 2});
  await service.process('pin'); oldResult.resolve(result({rating: 1}));
  expect(await old).toBe('stale'); expect(stored()).toMatchObject({rating: 4.7, detailsRevision: 2, detailsState: 'complete'});
  expect(fetchDetails).toHaveBeenCalledTimes(2);
});

test('source, notes, visits, lists and explicit edit markers survive failed work and explicit retry', async () => {
  await seed('pin', {notes: 'note', sources: [{url: 'https://youtu.be/original'}], visited: true, listIds: ['list']});
  fetchDetails.mockRejectedValueOnce(new EngineError('dependency_error', {stage: 'details'}));
  await service.process('pin');
  await db.collection('pins').doc('pin').update({category: 'bars', city: 'Paris', country: 'France',
    detailsUserEditedFields: ['category', 'city', 'country']});
  await service.retry('pin', 'owner', 1, task().taskId); await service.process('pin');
  expect(stored()).toMatchObject({category: 'bars', city: 'Paris', country: 'France', notes: 'note',
    sources: [{url: 'https://youtu.be/original'}], visited: true, listIds: ['list'], rating: 4.7});
});

test('REGRESSION: compare-before-update user edits remain protected across explicit retry', async () => {
  await seed(); fetchDetails.mockRejectedValueOnce(new EngineError('dependency_error', {stage: 'details'}));
  await service.process('pin');
  // An older client writes effective fields but does not know the new marker.
  await db.collection('pins').doc('pin').update({category: 'bars', city: 'Paris', country: 'France'});
  await service.retry('pin', 'owner', 1, task().taskId); await service.process('pin');
  expect(stored()).toMatchObject({category: 'bars', city: 'Paris', country: 'France', rating: 4.7});
});

test('REGRESSION: sparse nested details do not erase previously known business attributes', async () => {
  await seed('pin', {paymentOptions: {acceptsCreditCards: true, acceptsDebitCards: true, acceptsCashOnly: null, acceptsNfc: null}});
  fetchDetails.mockImplementation(async () => {
    await context.current().beforeProviderDispatch();
    return result({payment_options: {accepts_cash_only: false}});
  });
  await service.process('pin');
  expect(stored().paymentOptions).toMatchObject({acceptsCreditCards: true, acceptsDebitCards: true, acceptsCashOnly: false});
});

test('concurrent explicit retries of one failed revision authorize one new attempt', async () => {
  await seed(); fetchDetails.mockRejectedValueOnce(new Error('offline')); await service.process('pin');
  const replies = await Promise.all(Array.from({length: 6}, () => service.retry('pin', 'owner', 1, task().taskId)));
  expect(replies).toEqual(Array(6).fill({status: 'queued', revision: 2}));
  await Promise.all([service.process('pin'), service.process('pin')]);
  await service.retry('pin', 'owner', 1, task().taskId); await service.process('pin');
  expect(task().revision).toBe(2); expect(fetchDetails).toHaveBeenCalledTimes(2);
});

test('cache completion may apply without dispatch, and creates no provider permission', async () => {
  await seed(); fetchDetails.mockResolvedValue(result());
  expect(await service.process('pin')).toBe('complete'); expect(task().dispatched).toBe(false);
  expect(await service.process('pin')).toBe('skipped'); expect(fetchDetails).toHaveBeenCalledTimes(1);
});
