jest.mock('../lib/firestore', () => ({admin: require('./helpers/fakeFirestore').makeAdmin()}));
const {FakeFirestore, FakeTimestamp, makeAdmin} = require('./helpers/fakeFirestore');
const {getRetryContext} = require('../lib/retryContext');
const {reviewDetections} = require('../lib/detectionReview');
const {admitEnrichmentJob, USER_LIMIT} = require('../lib/enrichAdmission');
const {createQueueMaintenance} = require('../lib/queueMaintenance');
const {createEngineFeatures} = require('../lib/engineFeatures');
const {RECOVERY} = require('../lib/media/analysisRecovery');
const db = new FakeFirestore();
const url = 'https://www.instagram.com/reel/AdmissionReview/';
const saved = {name: 'Cafe', city: 'Kyoto', placeId: 'saved', pinId: 'pin', status: 'saved'};
const clue = {name: 'Cafe', city: 'Brooklyn', country: 'USA', source: 'vision', status: 'unresolved',
  ranking: {candidates: [{placeId: 'saved'}]}, failure: {code: 'no_verified_match', stage: 'matching'}};
const remaining = {...clue, city: 'Paris', country: 'France'};
const operation = {kind: 'asr_chunk', retryKey: 'a'.repeat(64), generation: 2};
const child = (retryOf = 'blocked', retryKind = 'places') => db.seed('enrichmentJobs', 'next', {userId: 'u', url, retryOf,
  ...(retryKind === undefined ? {} : {retryKind})});
const receipt = (id = 'blocked', retryOf = 'original', extra = {}) => db.seed('enrichmentJobs', id, {
  userId: 'u', url, retryOf, retryKind: 'places', status: 'failed', engineQueued: false,
  failure: {code: 'queue_full', stage: 'admission'}, ...extra});
const context = () => getRetryContext(db, 'next', 'u', url);
beforeEach(async () => {
  db.reset(); db.strictReadOrder = true;
  db.seed('pins', 'pin', {userId: 'u', placeId: 'saved', placeName: 'Cafe'});
  db.seed('enrichmentJobs', 'original', {userId: 'u', url, engineVersion: {schema: 2}, status: 'failed',
    failure: {code: 'partial_save'}, outcomes: [saved, clue, remaining], analysisRecovery: RECOVERY, mediaRetryOperations: [operation]});
  const preview = await reviewDetections(db, 'u', {jobId: 'original'});
  await reviewDetections(db, 'u', {jobId: 'original', version: preview.version,
    decisions: [{outcomeId: preview.items[0].outcomeId, action: 'same_place'}]});
});
afterEach(() => jest.restoreAllMocks());

test.each(['queue_full', 'admission_paused', 'invalid_configuration', 'queue_expired'])(
  'real %s receipt preserves reviewed evidence, remaining branch and recovery without writes', async kind => {
    const request = {jobId: 'blocked', userId: 'u', url, retryOf: 'original', retryKind: 'places'};
    let features = createEngineFeatures();
    if (kind === 'queue_full') db.seed('engineAdmission', 'u', {active: Array.from({length: USER_LIMIT}, (_, i) => ({id: `busy-${i}`, expires: Date.now() + 60000}))});
    if (kind === 'admission_paused') features = createEngineFeatures({admission: {stopNewJobs: true}});
    if (kind === 'invalid_configuration') features = {forJob: () => {throw new Error('Invalid configuration');}};
    await admitEnrichmentJob(db, request, {features});
    if (kind === 'queue_expired') {
      await db.collection('enrichmentJobs').doc('blocked').update({queueDeadline: FakeTimestamp.fromMillis(1)});
      await createQueueMaintenance({db, admin: makeAdmin()}).sweep();
    }
    expect(db.read('enrichmentJobs', 'blocked')).toMatchObject({status: 'failed', engineQueued: false, failure: {stage: 'admission'}});
    const original = structuredClone(db.read('enrichmentJobs', 'original'));
    child(); db.setWriteFailure(() => new Error('Retry context must only read'));
    const retry = await context();
    expect(retry.initialOutcomes).toEqual(original.outcomes);
    expect(retry.baseOutcomes).toEqual(original.outcomes.slice(0, 2));
    expect(retry.baseOutcomes[1]).toMatchObject({status: 'dismissed', source: 'vision', review: {action: 'same_place'}});
    expect(retry.resumePlaces).toEqual([expect.objectContaining({name: 'Cafe', city: 'Paris', country: 'France'})]);
    expect(retry).toMatchObject({analysisRecovery: RECOVERY, mediaRetryOperations: [operation]});
    expect(db.read('enrichmentJobs', 'original')).toEqual(original);
  });

test('legacy ordinary retries cross mixed admission failures and retain selected candidate authority', async () => {
  const candidate = {userId: 'u', placeId: 'chosen', placeName: 'Chosen Cafe', latitude: 35, longitude: 135};
  const original = db.read('enrichmentJobs', 'original');
  await db.collection('enrichmentJobs').doc('original').update({candidates: [candidate], selectedPlaceIds: ['chosen'],
    outcomes: [...original.outcomes, {name: 'Chosen Cafe', placeId: 'chosen', status: 'unresolved'}]});
  receipt('older', 'original', {retryKind: undefined, failure: {code: 'dependency_error', stage: 'admission'}});
  receipt('blocked', 'older', {retryKind: undefined});
  db.seed('enrichmentJobs', 'next', {userId: 'u', url, retryOf: 'blocked'});
  const retry = await context();
  expect(retry.baseOutcomes).toEqual(original.outcomes.slice(0, 2));
  expect(retry.resumePlaces).toContainEqual(expect.objectContaining({name: 'Cafe', city: 'Paris'}));
  expect(retry.resumePlaces).toContainEqual(expect.objectContaining({placeId: 'chosen', confirmedPlaceId: 'chosen'}));
  expect(retry.recoveryCandidates).toEqual([candidate]);
});

test('a substantive failed result is authoritative even with admission-shaped failure metadata', async () => {
  const newOutcome = {name: 'New evidence', city: 'Osaka', status: 'unresolved'};
  receipt('blocked', 'original', {outcomes: [newOutcome]}); child();
  const retry = await context();
  expect(retry.initialOutcomes).toEqual([newOutcome]); expect(retry.baseOutcomes).toEqual([]);
  expect(retry.analysisRecovery).toBeUndefined();
});

test.each([
  {outcomes: []}, {outcomes: null}, {analysisRecovery: null}, {analysisRecovery: RECOVERY},
  {candidates: []}, {retryCandidates: []}, {selectedPlaceIds: []}, {mediaRetryOperations: []},
  {progress: {saved: 0, total: 0}}, {unresolvedCount: 0}, {detectionReview: {schema: 1, revision: 1}},
  {pinId: 'pin'}, {existingPinId: 'pin'}, {sourceAdded: false}, {evidenceCoverage: {}},
  {processingStartedAt: FakeTimestamp.fromMillis(1)}, {workerOwner: 'worker'},
  {workerQueuePolicy: 'legacy'}, {engineDeadline: FakeTimestamp.fromMillis(100)}, {attempts: 0}, {stageFailures: []}
])('stored result or execution marker %p prevents ancestor resurrection', async extra => {
  receipt('blocked', 'original', extra); child();
  const retry = await context();
  expect(retry.initialOutcomes).toEqual([]); expect(retry.baseOutcomes).toEqual([]);
  expect(retry.analysisRecovery).toEqual(extra.analysisRecovery === RECOVERY ? RECOVERY : undefined);
});

test.each([
  {failure: {code: 'queue_full', stage: 'coordination'}},
  {failure: {code: 'dependency_error', stage: 'save'}},
  {failure: {code: 'dependency_timeout', stage: 'execution'}},
  {failure: {code: 'no_place_found', stage: 'admission'}},
  {failure: {code: 'queue_full', stage: 'queue'}},
  {failure: {code: 'queue_full'}}, {engineQueued: true}, {engineQueued: undefined},
  {retryKind: 'analysis'}, {status: 'complete'}, {status: 'duplicate'}, {status: 'needs_selection'}
])('unrecognized failure or receipt state %p is not traversed', async extra => {
  receipt('blocked', 'original', extra); child();
  expect(await context()).toMatchObject({initialOutcomes: [], baseOutcomes: []});
});

test.each(['blocked', 'bridge', 'original'].flatMap(id => ['userId', 'url'].map(field => [id, field])))(
  '%s validates %s before using or traversing that ancestor', async (id, field) => {
    receipt('bridge'); receipt('blocked', 'bridge'); child();
    await db.collection('enrichmentJobs').doc(id).update({[field]: field === 'userId' ? 'other-user' : 'https://example.test/other'});
    await expect(context()).rejects.toMatchObject({code: 'access_blocked'});
  });

test.each(['pending', 'processing'])('an ancestor in %s is not traversed', async status => {
  receipt('bridge', 'original', {status}); receipt('blocked', 'bridge'); child();
  await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
});

test.each(['blocked', 'next', 'bridge'])('a cycle through %s fails closed', async target => {
  receipt('blocked', 'bridge'); receipt('bridge', target); child();
  await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
});

test.each(['bad/path', 'x'.repeat(201), 123])('malformed ancestor ID %p fails closed', async retryOf => {
  receipt('blocked', retryOf); child();
  await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
});

test.each([7, 8])('a chain with %i admission receipts respects the eight ancestor read limit', async count => {
  for (let i = 0; i < count; i++) receipt(`hop-${i}`, i + 1 < count ? `hop-${i + 1}` : 'original');
  child('hop-0');
  const prototype = Object.getPrototypeOf(db.collection('enrichmentJobs').doc('next'));
  const originalGet = prototype.get, reads = [];
  jest.spyOn(prototype, 'get').mockImplementation(function () {reads.push(this.id); return originalGet.call(this);});
  if (count === 7) expect((await context()).initialOutcomes).toEqual(db.read('enrichmentJobs', 'original').outcomes);
  else await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
  expect(reads).toHaveLength(9); // current job plus at most eight ancestors
});

test('missing ancestry after an admission receipt fails closed without changing direct legacy fallback', async () => {
  receipt('blocked', 'missing'); child();
  await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
  child('missing'); expect(await context()).toEqual({bypassCache: true});
});

test('explicit analysis ancestry and its null-recovery boundary retain their existing semantics', async () => {
  db.seed('enrichmentJobs', 'blocked', {userId: 'u', url, status: 'failed', retryOf: 'original', retryKind: 'analysis'});
  child('blocked', 'analysis');
  expect(await context()).toMatchObject({analysisRetry: true, analysisRecovery: RECOVERY,
    initialOutcomes: db.read('enrichmentJobs', 'original').outcomes});
  await db.collection('enrichmentJobs').doc('blocked').update({analysisRecovery: null});
  await expect(context()).rejects.toMatchObject({code: 'invalid_response'});
});
