const {FakeFirestore, FieldValue, FakeTimestamp} = require('./helpers/fakeFirestore');
const {reviewDetections, reviewedClueMatches} = require('../lib/detectionReview');
const {getRetryContext, retainUnresolved} = require('../lib/retryContext');
const {RECOVERY} = require('../lib/media/analysisRecovery');
const db = new FakeFirestore();
const url = 'https://www.instagram.com/reel/review/';
const saved = {status: 'saved', name: 'Orova Cafe & Wine Bar', city: 'New York', address: '10 First St', placeId: 'place', pinId: 'pin'};
const clue = {status: 'unresolved', name: saved.name, city: 'Brooklyn', address: '', country: 'USA', source: 'vision',
  ranking: {score: 0, candidates: [{placeId: 'place', score: 40, addressConflict: false}]},
  failure: {code: 'no_verified_match', stage: 'matching'}};
const pin = {userId: 'u', placeId: 'place', placeName: saved.name, formattedAddress: saved.address, city: saved.city, sources: [{url}]};
function seed(outcomes = [saved, clue], extra = {}) {
  db.seed('pins', 'pin', pin);
  db.seed('enrichmentJobs', 'job', {userId: 'u', url, engineVersion: {schema: 2}, status: 'failed', outcomes,
    progress: {saved: 1, total: outcomes.length}, failure: {code: 'partial_save'}, error: 'Some places remain unresolved', ...extra});
}
const preview = () => reviewDetections(db, 'u', {jobId: 'job'});
const decision = (p, action = 'same_place', index = 0) => ({jobId: 'job', version: p.version,
  decisions: [{outcomeId: p.items[index].outcomeId, action, ...(action === 'same_place' ? {savedPlaceId: 'place'} : {})}]});
const apply = body => reviewDetections(db, 'u', body, {now: () => 1234, serverTimestamp: FieldValue.serverTimestamp});
const job = () => db.read('enrichmentJobs', 'job');
beforeEach(() => {db.reset(); db.strictReadOrder = true; seed();});
afterEach(() => jest.restoreAllMocks());

test('preview is deterministic, read-only, bounded and offers conflicting geography only for explicit review', async () => {
  const before = structuredClone(job());
  const writes = jest.fn(); db.setWriteFailure((...args) => {writes(...args); return null;});
  const result = await preview();
  expect(result).toEqual({version: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 0, savedCount: 1, unresolvedCount: 1, completed: false,
    analysisRecovery: null, items: [{outcomeId: expect.any(String), name: clue.name, city: 'Brooklyn', address: '',
      savedPlace: {placeId: 'place', pinId: 'pin', name: saved.name, city: saved.city, address: saved.address}}]});
  expect(await preview()).toEqual(result); expect(job()).toEqual(before); expect(writes).not.toHaveBeenCalled();
});

test.each(['same_place', 'dismiss'])('%s changes only the original clue and job summary, preserving evidence and recovery', async action => {
  seed([saved, clue], {analysisRecovery: {...RECOVERY, privateTranscript: 'not public'}, mediaRetryOperations: [{kind: 'keep'}]});
  db.seed('users', 'u', {pinCount: 7}); db.seed('pinDetailTasks', 'pin', {status: 'queued'});
  const beforePins = structuredClone(db.read('pins', 'pin'));
  const writes = []; db.setWriteFailure((collection, id) => {writes.push([collection, id]); return null;});
  const result = await apply(decision(await preview(), action));
  expect(result).toMatchObject({completed: true, savedCount: 1, unresolvedCount: 0, analysisRecovery: RECOVERY, items: []});
  expect(result.analysisRecovery.privateTranscript).toBeUndefined();
  expect(job()).toMatchObject({status: 'complete', failure: null, error: null, progress: {saved: 1, total: 1},
    analysisRecovery: {...RECOVERY, privateTranscript: 'not public'}, mediaRetryOperations: [{kind: 'keep'}]});
  expect(job().outcomes[0]).toEqual(saved);
  expect(job().outcomes[1]).toMatchObject({...clue, status: 'dismissed', review: {kind: 'detection_review', action, reviewedAt: 1234}});
  expect(db.read('pins', 'pin')).toEqual(beforePins); expect(db.read('users', 'u')).toEqual({pinCount: 7});
  expect(db.read('pinDetailTasks', 'pin')).toEqual({status: 'queued'}); expect(writes).toEqual([['enrichmentJobs', 'job']]);
  expect(await preview()).toEqual(result);
});

test('partial review leaves unrelated clues and failed partial contract; committed identities count only once', async () => {
  seed([saved, {...saved, status: 'existing'}, {...saved, placeId: undefined}, clue, {...clue, city: 'Paris'}], {analysisRecovery: RECOVERY});
  const p = await preview(); expect(p.savedCount).toBe(1); expect(p.unresolvedCount).toBe(2);
  expect(new Set(p.items.map(i => i.outcomeId)).size).toBe(2);
  const result = await apply(decision(p));
  expect(result).toMatchObject({completed: false, savedCount: 1, unresolvedCount: 1, analysisRecovery: RECOVERY});
  expect(job()).toMatchObject({status: 'failed', progress: {saved: 1, total: 2}, failure: {code: 'partial_save'}});
  expect(job().outcomes[4]).toEqual({...clue, city: 'Paris'});
  expect(result.items).toHaveLength(result.unresolvedCount);
});

test.each([
  {placeId: 'place'}, {confirmedPlaceId: 'place'}, {pinId: 'pin'},
  {placeId: {}}, {failure: {code: 'dependency_error', stage: 'save'}},
  {failure: {code: 'source_attachment_failed'}}, {failure: {stage: 'attachment'}},
  {ranking: undefined}, {ranking: {candidates: []}}, {ranking: {candidates: [{}]}},
  {ranking: {candidates: [{placeId: 'place'}, {placeId: 'other'}]}},
  {ranking: {candidates: [{placeId: 'place'}, {placeId: 'place'}]}},
  {ranking: {candidates: [{placeId: 'forged'}]}},
  {name: 'Orova'}, {name: 'Orova Cafe & Wine Bar — Downtown'},
  {name: 'Orova Cafe & Wine Bar (Soho)'}
])('unsafe clue %p remains visible but cannot be linked as same_place', async change => {
  seed([saved, {...clue, ...change}]);
  const p = await preview(); expect(p.items).toHaveLength(1); expect(p.items[0].savedPlace).toBeUndefined();
  const before = structuredClone(job());
  await expect(apply(decision(p))).rejects.toMatchObject({code: 'invalid_decision', status: 400});
  expect(job()).toEqual(before);
  expect(await apply(decision(p, 'dismiss'))).toMatchObject({completed: true});
});

test.each(['missing', 'foreign', 'identity', 'name'])('a %s owned-pin association is never offered', async kind => {
  if (kind === 'missing') await db.collection('pins').doc('pin').delete();
  else await db.collection('pins').doc('pin').update(kind === 'foreign' ? {userId: 'other'} : kind === 'identity' ? {placeId: 'other'} : {placeName: 'Other Branch'});
  const p = await preview(); expect(p.items[0].savedPlace).toBeUndefined();
  await expect(apply(decision(p))).rejects.toMatchObject({status: 400});
});

test('full name normalization tolerates case and punctuation while keeping branch qualifiers', async () => {
  seed([saved, {...clue, name: '  OROVA café & Wine Bar. '}]);
  expect((await preview()).items[0].savedPlace.placeId).toBe('place');
});

test('ambiguous committed pin identities are not a suggestion, and uncommitted outcomes never qualify', async () => {
  seed([saved, {...saved, pinId: 'second'}, clue]); db.seed('pins', 'second', pin);
  expect((await preview()).items[0].savedPlace).toBeUndefined();
  seed([{...saved, name: 'Different place'}, {...saved, status: 'dismissed'}, clue]);
  expect((await preview()).items[0].savedPlace).toBeUndefined();
});

test.each(['pending', 'processing', 'needs_selection', 'duplicate', 'complete'])('%s jobs cannot be reviewed', async status => {
  seed([saved, clue], {status}); await expect(preview()).rejects.toMatchObject({status: 409});
});
test.each([
  {engineVersion: {schema: 1}}, {engineVersion: {}}, {failure: {code: 'dependency_error'}},
  {outcomes: [clue]}, {outcomes: [saved]}, {outcomes: [saved, {...clue, status: 'candidate'}]},
  {outcomes: [saved, null]}, {outcomes: [saved, ...Array.from({length: 160}, () => clue)]}
])('invalid/non-partial job %p is not reviewable', async extra => {
  seed([saved, clue], extra); await expect(preview()).rejects.toMatchObject({status: 409});
});

test.each(['other', '', null])('owner %p cannot read or mutate a job', async user => {
  const p = await preview();
  for (const body of [{jobId: 'job'}, decision(p)]) await expect(reviewDetections(db, user, body)).rejects.toMatchObject({status: 403});
});
test('nonexistent job cannot be recreated', async () => {
  await expect(reviewDetections(db, 'u', {jobId: 'missing'})).rejects.toMatchObject({status: 403});
  expect(db.read('enrichmentJobs', 'missing')).toBeUndefined();
});

test.each(['outcome', 'savedPlace', 'sibling', 'duplicate'])('forged %s decisions fail atomically', async kind => {
  seed([saved, clue, {...clue, name: 'Unrelated'}]); const p = await preview(), body = decision(p);
  if (kind === 'outcome') body.decisions.push({outcomeId: 'made_up', action: 'dismiss'});
  if (kind === 'savedPlace') body.decisions[0].savedPlaceId = 'invented';
  if (kind === 'sibling') body.decisions.push({outcomeId: p.items[1].outcomeId, action: 'same_place', savedPlaceId: 'place'});
  if (kind === 'duplicate') body.decisions.push({...body.decisions[0]});
  const before = structuredClone(job());
  await expect(apply(body)).rejects.toMatchObject({status: 400}); expect(job()).toEqual(before);
});

test('optional savedPlaceId uses only the currently offered server-owned pin', async () => {
  const body = decision(await preview()); delete body.decisions[0].savedPlaceId;
  expect(await apply(body)).toMatchObject({completed: true});
  expect(job().outcomes[1].review).toMatchObject({savedPlaceId: 'place', pinId: 'pin'});
});

test.each(['outcome', 'ranking', 'status', 'address', 'city', 'pinId', 'pinOwner', 'pinIdentity', 'pinName', 'delete', 'recreate', 'recovery'])('stale %s state prevents an old tap', async kind => {
  const p = await preview();
  if (kind === 'outcome') await db.collection('enrichmentJobs').doc('job').update({outcomes: [saved, {...clue, city: 'Paris'}]});
  if (kind === 'ranking') await db.collection('enrichmentJobs').doc('job').update({outcomes: [saved, {...clue, ranking: {candidates: []}}]});
  if (kind === 'status') await db.collection('enrichmentJobs').doc('job').update({status: 'processing'});
  if (kind === 'address') await db.collection('pins').doc('pin').update({formattedAddress: '11 Second Street'});
  if (kind === 'city') await db.collection('pins').doc('pin').update({city: 'Paris'});
  if (kind === 'pinOwner') await db.collection('pins').doc('pin').update({userId: 'other'});
  if (kind === 'pinIdentity') await db.collection('pins').doc('pin').update({placeId: 'new'});
  if (kind === 'pinName') await db.collection('pins').doc('pin').update({placeName: 'New Branch'});
  if (kind === 'pinId') {db.seed('pins', 'replacement', pin); await db.collection('enrichmentJobs').doc('job').update({outcomes: [{...saved, pinId: 'replacement'}, clue]});}
  if (['delete', 'recreate'].includes(kind)) {await db.collection('pins').doc('pin').delete(); if (kind === 'recreate') {db.setNow(() => Date.now() + 10000); db.seed('pins', 'pin', pin);}}
  if (kind === 'recovery') await db.collection('enrichmentJobs').doc('job').update({analysisRecovery: RECOVERY});
  const before = structuredClone(job());
  await expect(apply(decision(p))).rejects.toMatchObject({status: 409}); expect(job()).toEqual(before);
});

test('job and pins are reread inside the mutation transaction, not trusted from the preview', async () => {
  const p = await preview(), original = db.runTransaction.bind(db), reads = [];
  db.runTransaction = async callback => {
    await db.collection('pins').doc('pin').update({formattedAddress: 'changed between requests'});
    return original(async txn => callback({...txn, get: async ref => {reads.push(`${ref.collection}/${ref.id}`); return txn.get(ref);}}));
  };
  try {await expect(apply(decision(p))).rejects.toMatchObject({status: 409});}
  finally {db.runTransaction = original;}
  expect(reads).toEqual(['enrichmentJobs/job', 'pins/pin']); expect(job().outcomes[1].status).toBe('unresolved');
});

test('transaction failure leaves every outcome untouched and permits retry', async () => {
  const body = decision(await preview()); const before = structuredClone(job());
  db.setWriteFailure(() => new Error('storage failure'));
  await expect(apply(body)).rejects.toThrow('storage failure'); expect(job()).toEqual(before);
  db.setWriteFailure(null); expect(await apply(body)).toMatchObject({completed: true});
});

test.each([false, true])('concurrent double taps are idempotent with remaining clues=%s', async partial => {
  if (partial) seed([saved, clue, {...clue, city: 'Paris'}]);
  const body = decision(await preview()), writes = [];
  db.setWriteFailure((c, id) => {writes.push([c, id]); return null;});
  const results = await Promise.all(Array.from({length: 4}, () => apply(body)));
  for (const result of results) expect(result).toEqual(results[0]);
  expect(writes).toEqual([['enrichmentJobs', 'job']]); expect(await apply(body)).toEqual(results[0]);
});

test('a repeated request cannot dismiss newly changed work or bypass a changed pin', async () => {
  seed([saved, clue, {...clue, city: 'Paris'}]); const body = decision(await preview()); await apply(body);
  await db.collection('enrichmentJobs').doc('job').update({outcomes: [saved, {...clue, city: 'London'}, job().outcomes[2]]});
  await expect(apply(body)).rejects.toMatchObject({status: 409}); expect(job().outcomes[1].status).toBe('unresolved');
  const next = decision(await preview()); await apply(next);
  await db.collection('pins').doc('pin').update({formattedAddress: 'Moved'});
  await expect(apply(next)).rejects.toMatchObject({status: 409});
});

test('two different taps from one preview cannot dismiss a new sibling without reloading', async () => {
  seed([saved, clue, {...clue, city: 'Paris'}]); const p = await preview();
  const results = await Promise.allSettled([apply(decision(p)), apply(decision(p, 'dismiss', 1))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.status).toBe(409);
  expect((await preview()).unresolvedCount).toBe(1);
});

test('sanitized display text never affects raw conflict fingerprint or leaks internal data', async () => {
  const long = 'A'.repeat(1000); seed([saved, {...clue, name: `\u0000${long}\u202e`, city: long, address: long, privateToken: 'secret'}]);
  const p = await preview(); expect(p.items[0].name).toBe('A'.repeat(200));
  expect(p.items[0].city).toHaveLength(200); expect(p.items[0].address).toHaveLength(500);
  expect(JSON.stringify(p)).not.toMatch(/secret|ranking|failure|\u202e/);
  await db.collection('enrichmentJobs').doc('job').update({outcomes: [saved, {...job().outcomes[1], address: `${long}changed`} ]});
  expect((await preview()).items[0].address).toBe(p.items[0].address);
  await expect(apply(decision(p, 'dismiss'))).rejects.toMatchObject({status: 409});
});

test.each([null, false, [], {}, {jobId: '../job'}, {jobId: 'job', version: 'bad'}, {jobId: 'job', decisions: []},
  {jobId: 'job', version: 'a'.repeat(64), decisions: []}, {jobId: 'job', userId: 'u'},
  {jobId: 'job', version: 'a'.repeat(64), decisions: [{outcomeId: 'x', action: 'auto'}]},
  {jobId: 'job', version: 'a'.repeat(64), decisions: [{outcomeId: 'x', action: 'dismiss', savedPlaceId: 'place'}]},
  {jobId: 'job', version: 'a'.repeat(64), decisions: [{outcomeId: 'x', action: 'dismiss', name: 'fake'}]},
  {jobId: 'job', version: 'a'.repeat(64), decisions: Array.from({length: 161}, (_, i) => ({outcomeId: `x${i}`, action: 'dismiss'}))}
])('invalid request %p does not enter a transaction', async body => {
  const run = jest.spyOn(db, 'runTransaction'); await expect(apply(body)).rejects.toMatchObject({status: 400}); expect(run).not.toHaveBeenCalled();
});

test('retry context and retention preserve exact reviewed evidence, not another branch/geography', async () => {
  seed([saved, clue, {...clue, city: 'Paris'}], {analysisRecovery: RECOVERY}); await apply(decision(await preview()));
  const reviewed = job().outcomes[1];
  db.seed('enrichmentJobs', 'child', {userId: 'u', url, retryOf: 'job'});
  const retry = await getRetryContext(db, 'child', 'u', url);
  expect(retry.baseOutcomes).toContainEqual(reviewed); expect(retry.analysisRecovery).toEqual(RECOVERY);
  expect(retry.resumePlaces).toHaveLength(1); expect(retry.resumePlaces[0].city).toBe('Paris');
  expect(retainUnresolved([clue], [reviewed])).toEqual([]);
  for (const changed of [{city: 'Paris'}, {address: '1 Main St'}, {country: 'France'}, {name: `${clue.name} Downtown`}, {placeId: 'place'}]) {
    expect(reviewedClueMatches(reviewed, {...clue, ...changed})).toBe(false);
    expect(retainUnresolved([{...clue, ...changed}], [reviewed])).toEqual([{...clue, ...changed}]);
  }
  expect(reviewedClueMatches(reviewed, {...clue, name: clue.name.toUpperCase()})).toBe(true);
});

test('explicit dismissal of a failed bound save is exact-clue scoped, and IDs are case sensitive', async () => {
  seed([saved, {...clue, placeId: 'CaseSensitive', failure: {stage: 'save'}}]);
  await apply(decision(await preview(), 'dismiss')); const reviewed = job().outcomes[1];
  expect(reviewedClueMatches(reviewed, {...reviewed, city: 'Paris'})).toBe(false);
  expect(reviewedClueMatches(reviewed, {...reviewed, placeId: 'casesensitive'})).toBe(false);
});

test.each(['', '   ', '\u0000\u202e\n', null, undefined, {private: 'not a name'}])('malformed unresolved name %p fails closed without dropping an item', async name => {
  seed([saved, {...clue, name}]);
  await expect(preview()).rejects.toMatchObject({status: 409, code: 'review_unavailable'});
});

test('summary limit uses unique committed identities and all unresolved clues, with a boundary of 100', async () => {
  seed([saved, ...Array.from({length: 99}, (_, i) => ({...clue, city: `City ${i}`}))]);
  const p = await preview(); expect(p.savedCount + p.unresolvedCount).toBe(100);
  seed([saved, ...Array.from({length: 100}, (_, i) => ({...clue, city: `City ${i}`}))]);
  await expect(preview()).rejects.toMatchObject({status: 409, code: 'review_unavailable'});
  seed([...Array.from({length: 100}, () => saved), clue]);
  expect(await preview()).toMatchObject({savedCount: 1, unresolvedCount: 1});
  seed([...Array.from({length: 100}, (_, i) => ({...saved, placeId: `place-${i}`, pinId: `pin-${i}`})), clue]);
  await expect(preview()).rejects.toMatchObject({status: 409});
});

test('The prefix difference stays ineligible for same_place and supports explicit dismiss', async () => {
  const name = 'The Chef’s Table at Brooklyn Fare';
  seed([{...saved, name}, {...clue, name: 'Chef’s Table at Brooklyn Fare'}]);
  await db.collection('pins').doc('pin').update({placeName: name});
  const p = await preview(); expect(p.items[0].savedPlace).toBeUndefined();
  await expect(apply(decision(p))).rejects.toMatchObject({status: 400});
  expect(await apply(decision(p, 'dismiss'))).toMatchObject({completed: true, savedCount: 1});
});

test('mutation updates discovery timestamp; server resolution and unrelated timestamp refresh preserve resultVersion', async () => {
  seed([saved, clue], {updatedAt: FakeTimestamp.fromMillis(100)}); db.setNow(() => 200);
  const body = decision(await preview()), result = await apply(body);
  expect(job().updatedAt.toMillis()).toBe(200);
  expect(await preview()).toEqual(result);
  db.setNow(() => 300); expect(await apply(body)).toEqual(result);
  expect(job().updatedAt.toMillis()).toBe(200); // delivery replay writes nothing
  await db.collection('enrichmentJobs').doc('job').update({updatedAt: FieldValue.serverTimestamp()});
  expect(job().updatedAt.toMillis()).toBe(300);
  expect(await apply(body)).toEqual(result);
});

test('transaction callback retry revalidates the pin and discards its first proposed update', async () => {
  const body = decision(await preview()), original = db.runTransaction.bind(db), proposed = [];
  db.runTransaction = async callback => {
    await callback({get: ref => ref.get(), update: (ref, update) => proposed.push(update)});
    await db.collection('pins').doc('pin').update({userId: 'another-owner'});
    return original(callback);
  };
  try {await expect(apply(body)).rejects.toMatchObject({status: 409});}
  finally {db.runTransaction = original;}
  expect(proposed).toHaveLength(1); expect(job().outcomes[1].status).toBe('unresolved');
  expect(job().detectionReview).toBeUndefined();
});


test('review revision only advances for new decisions, including partial completion', async () => {
  seed([saved, clue, {...clue, city:'Paris'}]);
  const p = await preview(); expect(p.revision).toBe(0);
  const firstRequest = decision(p);
  const first = await apply(firstRequest); expect(first.revision).toBe(1);
  expect(job().detectionReview.revision).toBe(1);
  expect((await apply(firstRequest)).revision).toBe(1);
  const second = await apply(decision(await preview(), 'dismiss'));
  expect(second).toMatchObject({revision:2,completed:true});
  expect((await preview()).revision).toBe(2);
});

test.each([-1, 0.5, '1', Number.MAX_SAFE_INTEGER])('invalid review revision %p cannot mutate work', async revision => {
  seed([saved,clue],{detectionReview:{schema:1,revision}});
  await expect(preview()).rejects.toMatchObject({status:409});
});
