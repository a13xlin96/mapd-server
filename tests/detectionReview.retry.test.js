jest.mock('../lib/firestore', () => ({firestore: require('./helpers/fakeFirestore').getSharedFirestore(), admin: require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/extraction', () => ({extractPublicPost: jest.fn()}));
jest.mock('../lib/media/videoEvidence', () => ({collectVideoEvidence: jest.fn()}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(async () => '')}));
jest.mock('../lib/vision', () => ({extractPlacesFromSlides: jest.fn(async () => ({places: []}))}));
jest.mock('../enrich/ai', () => ({aiExtractPlaces: jest.fn(), aiExtractPlace: jest.fn(), aiVerifyPlace: jest.fn()}));
jest.mock('../enrich/places', () => ({searchGooglePlaces: jest.fn(), getCachedPlaceDetails: jest.fn(async () => null)}));
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn(async () => {})}));
jest.mock('../lib/interestProfile', () => ({recordPinSaved: jest.fn(async () => {})}));
const {firestore: db} = require('../lib/firestore');
const {runEnrichment, saveSelectedPlaces} = require('../enrich');
const {reviewDetections} = require('../lib/detectionReview');
const {getRetryContext} = require('../lib/retryContext');
const {extractPublicPost} = require('../lib/extraction');
const {collectVideoEvidence} = require('../lib/media/videoEvidence');
const {aiExtractPlaces, aiVerifyPlace} = require('../enrich/ai');
const {searchGooglePlaces} = require('../enrich/places');
const {createEngineFeatures} = require('../lib/engineFeatures');
const {RECOVERY} = require('../lib/media/analysisRecovery');
const {EngineError} = require('../lib/engineError');
const url = 'https://www.instagram.com/reel/ReviewRetry/';
const media = createEngineFeatures({snapshotVersion: 2, internalUids: ['u'], flags: {mediaEvidence: true}}).forJob('u', undefined, ['mediaRecoveryV1']);
const clue = {name: 'Orova Cafe & Wine Bar', city: 'Brooklyn', country: 'USA', address: '2 Main St', source: 'vision',
  status: 'unresolved', ranking: {candidates: [{placeId: 'saved'}]}, failure: {code: 'no_verified_match', stage: 'matching'}};
const pin = (id, name = id) => ({placeId: id, placeName: name, userId: 'u', url, ogTitle: 'Dinner', ogImage: '', sourceApp: 'instagram',
  sourceDomain: 'instagram.com', category: 'restaurant', city: 'Kyoto', country: 'Japan', latitude: 35, longitude: 135});
const google = (id, name) => ({place_id: id, name, formatted_address: 'Kyoto, Japan', types: ['restaurant'], geometry: {location: {lat: 35, lng: 135}}});
const child = (id = 'child', parent = 'parent', extra = {}) => db.seed('enrichmentJobs', id, {userId: 'u', url, status: 'processing', retryOf: parent, ...extra});
const run = (id = 'child', features) => runEnrichment(id, url, 'u', '', {features, deadline: Date.now() + 120000});
async function reviewed({analysis = false, outcomes = [], action = 'same_place', original = clue} = {}) {
  db.seed('pins', 'saved-pin', {...pin('saved', clue.name), sources: []});
  db.seed('enrichmentJobs', 'parent', {userId: 'u', url, engineVersion: {schema: 2}, status: 'failed', failure: {code: 'partial_save'},
    ...(analysis ? {analysisRecovery: RECOVERY} : {}), outcomes: [
      {name: clue.name, city: 'Kyoto', country: 'Japan', placeId: 'saved', pinId: 'saved-pin', status: 'saved'}, original, ...outcomes]});
  const p = await reviewDetections(db, 'u', {jobId: 'parent'});
  await reviewDetections(db, 'u', {jobId: 'parent', version: p.version, decisions: [{outcomeId: p.items[0].outcomeId, action}]});
  return structuredClone(db.read('enrichmentJobs', 'parent').outcomes[1]);
}
beforeEach(() => {
  db.reset(); jest.clearAllMocks(); db.seed('users', 'u', {});
  extractPublicPost.mockResolvedValue({title: 'Dinner', description: 'Restaurants', webpage_url: url});
  aiExtractPlaces.mockResolvedValue({places: []}); aiVerifyPlace.mockResolvedValue({match: true, betterQuery: null});
  searchGooglePlaces.mockResolvedValue([]);
  collectVideoEvidence.mockResolvedValue({places: [], incomplete: false, attempted: true,
    coverage: {audio: {status: 'complete'}, visual: {status: 'complete'}, fusion: {status: 'complete'}}, retryOperations: []});
});

test.each([false, true])('reviewed exact clue stays dismissed across repeated retries, analysis=%s', async analysis => {
  const dismissal = await reviewed({analysis, outcomes: [{name: 'Still unknown', city: 'Paris', status: 'unresolved'}]});
  aiExtractPlaces.mockResolvedValue({places: [clue, {name: 'Still unknown', city: 'Paris'}]});
  child('child', 'parent', analysis ? {retryKind: 'analysis'} : {});
  if (analysis) collectVideoEvidence.mockResolvedValue({places: [clue], incomplete: true, attempted: true,
    error: new EngineError('dependency_timeout'), coverage: {audio: {status: 'failed'}, visual: {status: 'failed'}}, retryOperations: []});
  await run('child', analysis ? media : undefined);
  const j = db.read('enrichmentJobs', 'child');
  expect(j.outcomes).toContainEqual(dismissal); expect(j.outcomes.filter(o => o.status === 'unresolved').map(o => o.name)).toEqual(['Still unknown']);
  expect(j).toMatchObject({status: 'failed', progress: {saved: 1, total: 2}, failure: {code: 'partial_save'}});
  if (analysis) expect(j.analysisRecovery).toEqual(RECOVERY);
  expect(searchGooglePlaces.mock.calls.every(([q]) => !q.includes('Orova'))).toBe(true);
  child('third', 'child'); await run('third');
  expect(db.read('enrichmentJobs', 'third').outcomes).toContainEqual(dismissal);
  expect(searchGooglePlaces.mock.calls.every(([q]) => !q.includes('Orova'))).toBe(true);
  expect((await db.collection('pins').get()).size).toBe(1);
  expect(db.read('pins', 'saved-pin').sources).toEqual([]);
});

test.each([{city: 'Paris'}, {country: 'France'}, {address: '22 Other St'}, {name: `${clue.name} Downtown`}])('review dismissal never suppresses different clue %p', async change => {
  const dismissal = await reviewed({outcomes: [{name: 'Trigger reanalysis', status: 'unresolved'}]});
  const different = {...clue, ...change};
  aiExtractPlaces.mockResolvedValue({places: [clue, different]}); child(); await run();
  expect(searchGooglePlaces).toHaveBeenCalledTimes(1);
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(dismissal);
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(expect.objectContaining({...change, status: 'unresolved'}));
  expect(db.read('enrichmentJobs', 'child')).toMatchObject({status: 'failed', progress: {saved: 1, total: 2}});
});

test('a new bound identity with the same text survives an earlier unbound clue dismissal', async () => {
  const candidate = pin('chosen', clue.name);
  const dismissal = await reviewed({outcomes: [{...clue, placeId: 'chosen', confirmedPlaceId: 'chosen'}]});
  await db.collection('enrichmentJobs').doc('parent').update({candidates: [candidate], selectedPlaceIds: ['chosen']});
  child(); await run();
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(dismissal);
  expect(db.read('enrichmentJobs', 'child')).toMatchObject({status: 'complete', progress: {saved: 2, total: 2}});
  expect((await db.collection('pins').get()).docs.map(d => d.data().placeId).sort()).toEqual(['chosen', 'saved']);
  expect(searchGooglePlaces).not.toHaveBeenCalled();
});

test('explicitly dismissed bound save cannot suppress a different geography even when later matching returns its ID', async () => {
  const original = {...clue, placeId: 'chosen', confirmedPlaceId: 'chosen', failure: {stage: 'save'}};
  const dismissal = await reviewed({original, action: 'dismiss', outcomes: [{name: 'Unknown', status: 'unresolved'}]});
  const fresh = {name: clue.name, city: 'Osaka', country: 'Japan', address: ''};
  aiExtractPlaces.mockResolvedValue({places: [fresh]}); searchGooglePlaces.mockResolvedValue([{...google('chosen', clue.name), formatted_address: 'Osaka, Japan'}]);
  child(); await run();
  expect(searchGooglePlaces).toHaveBeenCalled();
  const j = db.read('enrichmentJobs', 'child'); expect(j.outcomes).toContainEqual(dismissal);
  expect(j.outcomes).toContainEqual(expect.objectContaining({placeId: 'chosen', city: 'Osaka', status: 'candidate'}));
  await saveSelectedPlaces('child', 'u', ['chosen']);
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(dismissal);
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(expect.objectContaining({placeId: 'chosen', city: 'Osaka', status: 'saved'}));
});

test('a selected retry for the same ID at a different clue preserves the original reviewed dismissal', async () => {
  const original = {...clue, placeId: 'chosen', confirmedPlaceId: 'chosen', failure: {stage: 'save'}};
  const different = {...original, city: 'Kyoto', country: 'Japan', address: ''};
  const dismissal = await reviewed({original, action: 'dismiss', outcomes: [different]});
  await db.collection('enrichmentJobs').doc('parent').update({candidates: [pin('chosen', clue.name)], selectedPlaceIds: ['chosen']});
  child(); await run(); const j = db.read('enrichmentJobs', 'child');
  expect(j.outcomes).toContainEqual(dismissal);
  expect(j.outcomes).toContainEqual(expect.objectContaining({placeId: 'chosen', city: 'Kyoto', status: 'saved'}));
  expect(j).toMatchObject({status: 'complete', progress: {saved: 2, total: 2}});
});

test('completed detection review retains independent analysis retry context', async () => {
  const dismissal = await reviewed({analysis: true}); child('child', 'parent', {retryKind: 'analysis'});
  const context = await getRetryContext(db, 'child', 'u', url);
  expect(context).toMatchObject({analysisRetry: true, analysisRecovery: RECOVERY}); expect(context.baseOutcomes).toContainEqual(dismissal);
  aiExtractPlaces.mockResolvedValue({places: [clue]}); await run('child', media);
  expect(db.read('enrichmentJobs', 'child').outcomes).toContainEqual(dismissal); expect(searchGooglePlaces).not.toHaveBeenCalled();
  expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
  expect(db.read('enrichmentJobs','child')).toMatchObject({status:'complete',progress:{saved:1,total:1},analysisRecovery:null,failure:null});
});

test('failed text analysis cannot use the all-reviewed success path when media succeeds', async () => {
  const dismissal = await reviewed({analysis:true}); child('child','parent',{retryKind:'analysis'});
  aiExtractPlaces.mockRejectedValue(new EngineError('dependency_timeout',{stage:'ai'}));
  await run('child',media);
  const j=db.read('enrichmentJobs','child');
  expect(j).toMatchObject({status:'failed',progress:{saved:1,total:1},analysisRecovery:null});
  expect(j.outcomes).toContainEqual(dismissal);
  expect(j.failure).toBeTruthy();
  expect(searchGooglePlaces).not.toHaveBeenCalled();
});

test('incomplete media after review keeps explicit analysis recovery without resurrecting the clue', async () => {
  const dismissal=await reviewed({analysis:true}); child('child','parent',{retryKind:'analysis'});
  aiExtractPlaces.mockResolvedValue({places:[clue]});
  collectVideoEvidence.mockResolvedValue({places:[],incomplete:true,attempted:true,
    error:new EngineError('dependency_timeout',{stage:'media'}),coverage:{audio:{status:'failed'}},retryOperations:[]});
  await run('child',media);
  const j=db.read('enrichmentJobs','child');
  expect(j).toMatchObject({status:'complete',progress:{saved:1,total:1},analysisRecovery:RECOVERY,failure:null});
  expect(j.outcomes).toContainEqual(dismissal);
  expect(searchGooglePlaces).not.toHaveBeenCalled();
});
