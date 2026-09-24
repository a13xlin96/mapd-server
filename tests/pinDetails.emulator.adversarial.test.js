// Opt-in local-only integration: FIRESTORE_EMULATOR_HOST=127.0.0.1:18981
// No credentials, external providers, deployed Functions or production project.
jest.mock('../lib/firestore', () => {
  const admin = require('firebase-admin');
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (host && !/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Only loopback Firestore is allowed');
  return {admin, firestore: host ? new admin.firestore.Firestore({projectId: 'demo-mapd-details-review', host, ssl: false}) : null};
});
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn()}));
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(async () => null), setCache: jest.fn(async () => {})}));
jest.mock('../lib/anthropic', () => ({anthropic: {messages: {create: jest.fn()}}}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(async () => '')}));
const {randomUUID} = require('crypto');
const {firestore: db, admin} = require('../lib/firestore');
const {enqueueNewPin, createPinDetails, generation} = require('../lib/pinDetails');
const {createPinDetailsWorker} = require('../lib/pinDetailsWorker');
const {writePinTransactional} = require('../enrich');
const context = require('../lib/jobContext');
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

suite('real Firestore deferred-details adversarial integration', () => {
  let uid, id, fetchDetails, service, clock;
  const ref = () => db.collection('pins').doc(id);
  const taskRef = () => db.collection('pinDetailTasks').doc(id);
  const pin = (patch = {}) => ({userId: uid, placeId: `place-${uid}`, placeName: 'Cafe',
    url: `https://www.instagram.com/reel/${uid}/`, ogTitle: 'Cafe', ogImage: '', sourceApp: 'instagram', sourceDomain: 'instagram.com',
    category: 'other', city: null, country: null, detailsSchemaVersion: 1, detailsState: 'pending', detailsRevision: 1, ...patch});
  const details = (patch = {}) => ({name: 'Cafe', types: ['cafe'], rating: 4.8,
    address_components: [{long_name: 'Kyoto', types: ['locality']}, {long_name: 'Japan', types: ['country']}], ...patch});
  const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
  async function seed() {
    const value = pin(); await db.runTransaction(async txn => {txn.set(ref(), value); enqueueNewPin(txn, db, admin, ref(), value);});
  }
  beforeEach(async () => {
    uid = `review-${randomUUID()}`; id = `pin-${uid}`; clock = Date.now();
    await db.collection('users').doc(uid).set({});
    fetchDetails = jest.fn(async () => {await context.current().beforeProviderDispatch(); return details();});
    service = createPinDetails({db, admin, fetchDetails, now: () => clock});
  });
  afterAll(async () => {await db.terminate();});

  test('actual enrich writer creates task, pin and index atomically with identical server createTime', async () => {
    const saved = await writePinTransactional(pin()); id = saved.pinId;
    const [p, t] = await Promise.all([ref().get(), taskRef().get()]);
    expect(p.exists).toBe(true); expect(t.exists).toBe(true); expect(p.createTime.isEqual(t.createTime)).toBe(true);
    expect(t.data()).toMatchObject({pinGeneration: null, sameCommit: true, status: 'queued'});
    expect(p.data().detailsTaskId).toBe(t.data().taskId);
    await Promise.all([service.process(id), service.process(id)]);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    expect((await taskRef().get()).data()).toMatchObject({pinGeneration: generation(p), status: 'complete', dispatched: true});
    expect((await ref().get()).data()).toMatchObject({detailsState: 'complete', rating: 4.8});
  }, 20000);

  test('actual writer appends a source without resetting an existing pending task', async () => {
    const saved = await writePinTransactional(pin()); id = saved.pinId;
    const original = await taskRef().get();
    const duplicate = await writePinTransactional(pin({url: `https://youtu.be/${uid}`}));
    expect(duplicate).toMatchObject({pinId: id, alreadyExists: true});
    const task = await taskRef().get(); expect(task.data()).toEqual(original.data());
    expect(task.createTime.isEqual(original.createTime)).toBe(true);
    expect((await ref().get()).data().sources).toHaveLength(2);
    expect(await service.process(id)).toBe('complete'); expect(fetchDetails).toHaveBeenCalledTimes(1);
  }, 20000);

  test('a task created in a different commit cannot authorize a pin through client generation flags', async () => {
    await ref().set(pin({createdAt: admin.firestore.Timestamp.fromMillis(0), generation: 'invented'}));
    await db.runTransaction(async txn => {enqueueNewPin(txn, db, admin, ref(), pin());});
    const [p, t] = await Promise.all([ref().get(), taskRef().get()]);
    expect(p.createTime.isEqual(t.createTime)).toBe(false);
    expect(await service.process(id)).toBe('skipped'); expect(fetchDetails).not.toHaveBeenCalled();
    expect((await taskRef().get()).data().status).toBe('cancelled');
  });

  test('deletion and recreation before the first claim refuses the stale original task', async () => {
    await seed(); const old = await ref().get(); await ref().delete();
    await ref().set(pin({createdAt: old.createTime, generation: generation(old)}));
    expect(generation(await ref().get())).not.toBe(generation(old));
    expect(await service.process(id)).toBe('skipped'); expect(fetchDetails).not.toHaveBeenCalled();
  });

  test('REGRESSION: a newly enqueued same-commit task can enrich a recreated pin at the same document ID', async () => {
    await seed(); await service.process(id); const originalTask = await taskRef().get();
    await ref().delete(); await seed();
    const [p, t] = await Promise.all([ref().get(), taskRef().get()]);
    // The replacement is a distinct pin generation, committed with its new task.
    // Reusing the task document must not bind it to the original creation time.
    expect(p.createTime.isEqual(originalTask.createTime)).toBe(false);
    expect(p.createTime.isEqual(t.updateTime)).toBe(true);
    expect(await service.process(id)).toBe('complete');
    expect((await ref().get()).data().detailsState).toBe('complete');
    expect(fetchDetails).toHaveBeenCalledTimes(2);
  });

  test('a user edit made during a real in-flight request survives transaction completion', async () => {
    await seed(); const ready = deferred(), response = deferred();
    fetchDetails.mockImplementationOnce(async () => {
      await context.current().beforeProviderDispatch(); ready.resolve(); return response.promise;
    });
    const processing = service.process(id); await ready.promise;
    await ref().update({category: 'bars', city: 'Paris', country: 'France', notes: 'keep', listIds: ['mine']});
    response.resolve(details()); expect(await processing).toBe('complete');
    expect((await ref().get()).data()).toMatchObject({category: 'bars', city: 'Paris', country: 'France', notes: 'keep', listIds: ['mine'], rating: 4.8});
  });

  test('old producer cannot apply to a replacement task/pin generation after dispatch', async () => {
    await seed(); const ready = deferred(), response = deferred();
    fetchDetails.mockImplementationOnce(async () => {
      await context.current().beforeProviderDispatch(); ready.resolve(); return response.promise;
    });
    const processing = service.process(id); await ready.promise;
    const batch = db.batch(); batch.delete(ref()); batch.delete(taskRef()); await batch.commit(); await seed();
    await service.process(id); response.resolve(details({rating: 1})); expect(await processing).toBe('stale');
    expect((await ref().get()).data()).toMatchObject({rating: 4.8, detailsState: 'complete'});
  });

  test('concurrent retry transactions authorize one new revision and redelivery is harmless', async () => {
    await seed(); fetchDetails.mockRejectedValueOnce(new Error('simulated failure')); await service.process(id);
    const taskId = (await taskRef().get()).data().taskId;
    const replies = await Promise.all(Array.from({length: 5}, () => service.retry(id, uid, 1, taskId)));
    expect(replies).toEqual(Array(5).fill({status: 'queued', revision: 2}));
    await service.process(id);
    expect(await service.retry(id, uid, 1, taskId)).toEqual({status: 'complete', revision: 2});
    expect(fetchDetails).toHaveBeenCalledTimes(2);
  }, 20000);

  test('REGRESSION: an old-generation retry cannot advance a replacement task in real Firestore', async () => {
    await seed(); fetchDetails.mockRejectedValueOnce(new Error('old attempt failed')); await service.process(id);
    const oldGeneration = generation(await ref().get());
    const oldTaskId = (await taskRef().get()).data().taskId;
    const batch = db.batch(); batch.delete(ref()); batch.delete(taskRef()); await batch.commit();
    await seed(); fetchDetails.mockRejectedValueOnce(new Error('new attempt failed')); await service.process(id);
    const replacement = await taskRef().get();
    expect(replacement.data().pinGeneration).not.toBe(oldGeneration);
    expect(replacement.data().taskId).not.toBe(oldTaskId);
    expect(replacement.data()).toMatchObject({status: 'needs_action', revision: 1});
    await expect(service.retry(id, uid, 1, oldTaskId)).rejects.toMatchObject({code: 'access_blocked'});
    expect((await taskRef().get()).data()).toMatchObject({status: 'needs_action', revision: 1});
  });

  test('restarted worker discovers durable queued work using the real Firestore query', async () => {
    await seed();
    const worker = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
    await worker.tick(); await worker.stop();
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    expect((await taskRef().get()).data().status).toBe('complete');
  });

  test('restarted worker expires an in-flight dead producer without restarting its share or spending again', async () => {
    await seed(); const ready = deferred(), response = deferred();
    const job = db.collection('enrichmentJobs').doc(`job-${uid}`);
    await job.set({userId: uid, status: 'complete', pinId: id});
    fetchDetails.mockImplementationOnce(async () => {
      await context.current().beforeProviderDispatch(); ready.resolve(); return response.promise;
    });
    const original = service.process(id); await ready.promise; clock += 50000;
    const restarted = createPinDetailsWorker({db, admin, fetchDetails, now: () => clock});
    await restarted.tick(); await restarted.tick(); await restarted.stop();
    response.resolve(details()); expect(await original).toBe('stale');
    expect((await taskRef().get()).data().status).toBe('needs_action');
    expect((await ref().get()).data().detailsState).toBe('needs_action');
    expect((await job.get()).data().status).toBe('complete'); expect(fetchDetails).toHaveBeenCalledTimes(1);
  });
});
