// Exercise the real enrichment pipeline, media collector and manifest validator.
// Only source/provider/process/storage boundaries are replaced; no network or
// media subprocesses are needed to verify the recorded audio-only policy.
jest.mock('../lib/firestore', () => ({
  firestore: require('./helpers/fakeFirestore').getSharedFirestore(),
  admin: require('./helpers/fakeFirestore').makeAdmin(),
}));
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(), setCache: jest.fn()}));
jest.mock('../lib/extraction', () => ({extractPublicPost: jest.fn()}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail: jest.fn(async () => '')}));
jest.mock('../lib/vision', () => ({extractPlacesFromSlides: jest.fn()}));
jest.mock('../enrich/ai', () => ({aiExtractPlaces: jest.fn(), aiExtractPlace: jest.fn(), aiVerifyPlace: jest.fn()}));
jest.mock('../enrich/places', () => ({
  searchGooglePlaces: jest.fn(), getCachedPlaceDetails: jest.fn(),
  getPlaceDetails: jest.fn(), findPlaceFromUrl: jest.fn(),
}));
jest.mock('../enrich/ogMetadata', () => ({
  ...jest.requireActual('../enrich/ogMetadata'), fetchOGMetadata: jest.fn(), resolveShortUrl: jest.fn(),
}));
jest.mock('../lib/instagramReel', () => ({
  ...jest.requireActual('../lib/instagramReel'), fetchInstagramReelPost: jest.fn(),
}));
jest.mock('../lib/push', () => ({sendPushForJob: jest.fn(async () => {})}));
jest.mock('../lib/interestProfile', () => ({recordPinSaved: jest.fn(async () => {})}));
jest.mock('../lib/media/mediaSource', () => ({
  ...jest.requireActual('../lib/media/mediaSource'), discoverMediaSource: jest.fn(),
}));
jest.mock('../lib/media/publicMediaDownload', () => ({acquireMedia: jest.fn(), acquireSeparateAudio: jest.fn()}));
jest.mock('../lib/media/mediaProcess', () => ({processMedia: jest.fn()}));
jest.mock('../lib/media/audioDecode', () => ({prepareAudioChunks: jest.fn()}));
jest.mock('../lib/media/transcriptionService', () => ({transcribeAudio: jest.fn()}));
jest.mock('../lib/media/fuseEvidence', () => ({fuseEvidence: jest.fn()}));
jest.mock('../lib/media/frameSelector', () => ({selectFrames: jest.fn()}));
jest.mock('../lib/media/videoVision', () => ({analyzeVideoFrames: jest.fn()}));

const {firestore: db} = require('../lib/firestore');
const {getCached, setCache} = require('../lib/cache');
const {extractPublicPost} = require('../lib/extraction');
const {extractPlacesFromSlides} = require('../lib/vision');
const {aiExtractPlaces, aiExtractPlace} = require('../enrich/ai');
const {searchGooglePlaces, getCachedPlaceDetails} = require('../enrich/places');
const {sendPushForJob} = require('../lib/push');
const {discoverMediaSource} = require('../lib/media/mediaSource');
const {acquireMedia, acquireSeparateAudio} = require('../lib/media/publicMediaDownload');
const {processMedia} = require('../lib/media/mediaProcess');
const {prepareAudioChunks} = require('../lib/media/audioDecode');
const {transcribeAudio} = require('../lib/media/transcriptionService');
const {fuseEvidence} = require('../lib/media/fuseEvidence');
const {selectFrames} = require('../lib/media/frameSelector');
const {analyzeVideoFrames} = require('../lib/media/videoVision');
const {createEngineFeatures} = require('../lib/engineFeatures');
const {EngineError} = require('../lib/engineError');
const {RECOVERY} = require('../lib/media/analysisRecovery');
const {admitEnrichmentJob} = require('../lib/enrichAdmission');
// Observe the real collector's result without replacing its implementation.
const collectVideoEvidence = jest.spyOn(require('../lib/media/videoEvidence'), 'collectVideoEvidence');
const {runEnrichment} = require('../enrich');

const url = 'https://www.instagram.com/reel/AUDIOONLY/';
const privateUrl = 'https://cdn.example/video.mp4?signature=PRIVATE_SIGNED_MEDIA';
const localPath = '/private/tmp/audio-only-fixture/PRIVATE_WORKSPACE/video.mp4';
const mediaDigest = 'a'.repeat(64);
const evidenceId = 'audio:PRIVATE_EVIDENCE:0';
const rawTranscript = 'We ate at Tai Sushi in Kyoto. PRIVATE_TRANSCRIPT_DETAIL.';
const visualDisabled = {status: 'unavailable', reason: 'disabled_by_policy', intervals: []};
const features = createEngineFeatures({
  snapshotVersion: 2, internalUids: ['u'], flags: {mediaEvidence: true},
  mediaPolicy: {policyVersion: 'media-v2', analysisMode: 'audio-only'},
}).forJob('u', undefined, ['mediaRecoveryV1']);
const google = {
  place_id: 'tai-sushi-kyoto', name: 'Tai Sushi',
  formatted_address: '1 Main Street, Kyoto, Japan', types: ['restaurant'],
  geometry: {location: {lat: 35, lng: 135}},
};
const spokenPlace = () => ({
  name: 'Tai Sushi', city: 'Kyoto', source: 'transcript', requiresSelection: true,
  evidenceRefs: [
    {evidenceId, quote: rawTranscript, supports: 'name'},
    {evidenceId, quote: 'Kyoto', supports: 'city'},
  ],
});
let dispose;

function run(options = {}) {
  // Read the serialized job snapshot, just as a worker does, rather than
  // selecting features again from the current rollout configuration.
  return runEnrichment('job', url, 'u', '', {
    features: db.read('enrichmentJobs', 'job').engineFeatures,
    leaseOwner: 'worker', deadline: Date.now() + 120000, ...options,
  });
}

function captionBaseline() {
  extractPublicPost.mockResolvedValue({title: 'Tai Sushi Kyoto', description: 'Tai Sushi Kyoto', webpage_url: url});
  aiExtractPlaces.mockResolvedValue({places: [{name: 'Tai Sushi', city: 'Kyoto'}]});
}

function expectNoVisualWork() {
  expect(selectFrames).not.toHaveBeenCalled();
  expect(analyzeVideoFrames).not.toHaveBeenCalled();
  expect(extractPlacesFromSlides).not.toHaveBeenCalled();
}

function expectNoPrivateEvidence(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [privateUrl, localPath, mediaDigest, evidenceId, rawTranscript,
    'PRIVATE_TRANSCRIPT_DETAIL', 'PRIVATE_PROVIDER_REQUEST', 'PRIVATE_AUDIO_BYTES']) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toMatch(/"(?:transcript|segments|evidenceRefs|observations|mediaDigest|localPath|requestId)"\s*:/);
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => {resolve = yes;});
  return {promise, resolve};
}

beforeEach(() => {
  db.reset();
  jest.clearAllMocks();
  db.seed('enrichmentJobs', 'job', {
    userId: 'u', url, status: 'processing', workerOwner: 'worker',
    engineFeatures: JSON.parse(JSON.stringify(features)),
  });
  getCached.mockResolvedValue(null);
  setCache.mockResolvedValue(undefined);
  extractPublicPost.mockResolvedValue({title: 'Dinner', description: '', webpage_url: url, subtitles: ''});
  aiExtractPlaces.mockResolvedValue({places: []});
  searchGooglePlaces.mockResolvedValue([google]);
  getCachedPlaceDetails.mockResolvedValue(null);
  discoverMediaSource.mockResolvedValue({availability: 'available', renditions: [{url: privateUrl}]});
  dispose = jest.fn(async () => {});
  acquireMedia.mockResolvedValue({contentDigest: mediaDigest, bytes: 500, localPath, dispose});
  processMedia.mockResolvedValue({durationMs: 3000, hasAudio: true});
  prepareAudioChunks.mockResolvedValue([{bytes: Buffer.from('PRIVATE_AUDIO_BYTES'), startMs: 0, endMs: 3000}]);
  transcribeAudio.mockResolvedValue({
    segments: [{text: rawTranscript, evidenceId, startMs: 0, endMs: 3000, origin: 'audio'}],
    coverage: {status: 'complete', intervals: [[0, 3000]]},
    requestId: 'PRIVATE_PROVIDER_REQUEST',
  });
  fuseEvidence.mockResolvedValue({places: [spokenPlace()], contradictions: []});
  // If visual work regresses, it produces a usable result rather than an
  // unrelated mock TypeError; the zero-call assertions catch the regression.
  selectFrames.mockResolvedValue({frames: [{digest: 'frame', timestampMs: 0, width: 10, height: 10}], scannedFrames: 1});
  analyzeVideoFrames.mockResolvedValue({places: [], observations: []});
});

test('real audio-only collection requires selection, never pins automatically, and keeps private evidence out of client output', async () => {
  await run();
  expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
  const media = await collectVideoEvidence.mock.results[0].value;
  expect(media).toMatchObject({attempted: true, incomplete: false, coverage: {
    audio: {status: 'complete', intervals: [[0, 3000]]}, fusion: {status: 'complete'},
  }});
  expect(media.coverage.visual).toEqual(visualDisabled);
  expect(media.places[0].evidenceRefs).toEqual(spokenPlace().evidenceRefs);
  expect(prepareAudioChunks).toHaveBeenCalledTimes(1);
  expect(transcribeAudio).toHaveBeenCalledTimes(1);
  expect(fuseEvidence).toHaveBeenCalledTimes(1);
  expect(fuseEvidence.mock.calls[0][0].textEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({modality: 'transcript', evidenceId, text: rawTranscript}),
  ]));
  expect(fuseEvidence.mock.calls[0][0].textEvidence.some(e => e.modality === 'visual')).toBe(false);
  expect(searchGooglePlaces).toHaveBeenCalledWith('Tai Sushi Kyoto');
  const job = db.read('enrichmentJobs', 'job');
  expect(job).toMatchObject({status: 'needs_selection', analysisRecovery: null, mediaRetryOperations: [],
    evidenceCoverage: {visual: {status: 'unavailable', reason: 'disabled_by_policy'}}});
  expect(job.candidates).toHaveLength(1);
  expect(job.candidates[0]).toMatchObject({placeId: google.place_id, placeName: 'Tai Sushi'});
  expect(job.outcomes).toEqual([expect.objectContaining({status: 'candidate', requiresSelection: true})]);
  expect((await db.collection('pins').get()).empty).toBe(true);
  expect(sendPushForJob).toHaveBeenCalledWith('job', 'u', 'needs_selection');
  const receipt = await admitEnrichmentJob(db, {jobId: 'job', userId: 'u', url});
  expect(receipt).toEqual({code: 200, body: {jobId: 'job', status: 'needs_selection'}});
  expectNoPrivateEvidence({job, receipt: receipt.body, pushes: sendPushForJob.mock.calls});
  expectNoVisualWork();
  expect(acquireSeparateAudio).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test.each([
  ['audio timeout', 'transcription', 'dependency_timeout'],
  ['discovery failure', 'source', 'source_unavailable'],
])('%s preserves a verified caption save with separate analysis recovery', async (_scenario, stage, code) => {
  captionBaseline();
  const error = new EngineError(code, {stage});
  if (stage === 'transcription') {
    error.retryOperations = [{kind: 'asr_chunk', retryKey: 'b'.repeat(64), generation: 1}];
    transcribeAudio.mockRejectedValue(error);
  } else discoverMediaSource.mockRejectedValue(error);

  await run();
  expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
  const media = await collectVideoEvidence.mock.results[0].value;
  expect(media).toMatchObject({incomplete: true, error: {code}, coverage: {audio: {status: 'failed', reason: code}}});
  expect(media.coverage.visual).toEqual(visualDisabled);
  const job = db.read('enrichmentJobs', 'job');
  expect(job).toMatchObject({status: 'complete', analysisRecovery: RECOVERY, progress: {saved: 1, total: 1}});
  expect(job.failure).toBeFalsy();
  expect(job.outcomes).toEqual([expect.objectContaining({status: 'saved', placeId: google.place_id})]);
  const pins = await db.collection('pins').get();
  expect(pins.size).toBe(1);
  expect(pins.docs[0].data()).toMatchObject({placeId: google.place_id, placeName: 'Tai Sushi'});
  expect(job.mediaRetryOperations).toEqual(error.retryOperations || []);
  expect(job.evidenceCoverage.visual).toEqual({status: 'unavailable', reason: 'disabled_by_policy'});
  expect(searchGooglePlaces).toHaveBeenCalledTimes(1);
  expect(aiExtractPlace).not.toHaveBeenCalled();
  expect(fuseEvidence).not.toHaveBeenCalled();
  expect(setCache).not.toHaveBeenCalled();
  expectNoVisualWork();
  expectNoPrivateEvidence({job, pins: pins.docs.map(doc => doc.data()), pushes: sendPushForJob.mock.calls});
  if (stage === 'transcription') {
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  } else {
    expect(acquireMedia).not.toHaveBeenCalled();
    expect(processMedia).not.toHaveBeenCalled();
    expect(prepareAudioChunks).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  }
});

test('successful audio-only analysis saves the caption baseline and completes a reusable manifest without a visual retry', async () => {
  captionBaseline();
  // Speech adds no venue: completion must still depend on audio/fusion success,
  // and an intentionally disabled visual modality must not create recovery.
  fuseEvidence.mockResolvedValue({places: [], contradictions: []});
  await run();
  const media = await collectVideoEvidence.mock.results[0].value;
  expect(media).toMatchObject({attempted: true, incomplete: false, places: [], retryOperations: [],
    coverage: {audio: {status: 'complete'}, fusion: {status: 'complete'}}});
  expect(media.coverage.visual).toEqual(visualDisabled);
  expect(media.error).toBeUndefined();
  expect(transcribeAudio).toHaveBeenCalledTimes(1);
  expect(fuseEvidence).toHaveBeenCalledTimes(1);
  expect(db.read('enrichmentJobs', 'job')).toMatchObject({
    status: 'complete', analysisRecovery: null, mediaRetryOperations: [], progress: {saved: 1, total: 1},
    evidenceCoverage: {audio: {status: 'complete'}, visual: {status: 'unavailable', reason: 'disabled_by_policy'},
      fusion: {status: 'complete'}},
  });
  expect((await db.collection('pins').get()).size).toBe(1);
  expect(setCache).toHaveBeenCalledTimes(1);
  const {timing,...reusableEvidence}=media;
  expect(timing).toMatchObject({durationMs:3000});
  expect(setCache).toHaveBeenCalledWith(expect.stringMatching(/^media-manifest-/),
    {version: 1, createdAt: expect.any(Number), result: reusableEvidence}, features.media.policy.manifestTtlSeconds);
  expect(setCache.mock.calls[0][1].result).not.toHaveProperty('timing');
  expect(db.read('engineMetrics', 'job').outcome).toBe('success');
  expectNoVisualWork();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('parent cancellation during fusion forbids a late audio result, manifest or pin commit', async () => {
  const entered = deferred(), late = deferred(), controller = new AbortController();
  fuseEvidence.mockImplementation(() => {entered.resolve(); return late.promise;});
  const pending = run({signal: controller.signal});
  try {
    // Race against completion so an early pipeline exit fails without hanging.
    await Promise.race([entered.promise, pending.then(() => {throw new Error('Pipeline exited before fusion');})]);
    const before = JSON.stringify(db.read('enrichmentJobs', 'job'));
    controller.abort();
    expect(fuseEvidence.mock.calls[0][1].signal.aborted).toBe(true);
    late.resolve({places: [spokenPlace()], contradictions: []});
    await pending;
    await expect(collectVideoEvidence.mock.results[0].value).rejects.toMatchObject({code: 'attempt_stopped'});
    expect(JSON.stringify(db.read('enrichmentJobs', 'job'))).toBe(before);
    expect((await db.collection('pins').get()).empty).toBe(true);
    expect(searchGooglePlaces).not.toHaveBeenCalled();
    expect(sendPushForJob).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
    expect(db.read('engineMetrics', 'job')).toBeUndefined();
    expectNoVisualWork();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    late.resolve({places: [], contradictions: []});
    await pending;
  }
});
