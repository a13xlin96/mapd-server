// Exercise admission -> worker -> shipped enrichment with only provider I/O mocked.
// Never inherit production provider configuration from the test runner's shell.
const originalEnv = process.env;
process.env = { NODE_ENV: 'test' };
afterAll(() => { process.env = originalEnv; });

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});
jest.mock('../lib/cache', () => ({
  ...jest.requireActual('../lib/cache'),
  getCached: jest.fn(async () => null), setCache: jest.fn(async () => {}),
}));
jest.mock('../lib/ytdlp', () => ({ runYtDlp: jest.fn() }));
jest.mock('../lib/tiktokPhoto', () => ({ isTikTokPhotoUrl: () => false }));
jest.mock('../lib/instagramCarousel', () => ({ isInstagramPostUrl: () => false }));
jest.mock('../lib/instagramReel', () => ({ isInstagramReelUrl: () => false }));
jest.mock('../lib/urlResolve', () => ({ isShortSocialUrl: () => false, resolveOneRedirect: jest.fn() }));
jest.mock('../lib/vision', () => ({ extractPlacesFromSlides: jest.fn() }));
jest.mock('../lib/thumbnails', () => ({ persistThumbnail: jest.fn(async () => '') }));
jest.mock('../lib/push', () => ({ sendPushForJob: jest.fn(async () => {}) }));
jest.mock('../lib/interestProfile', () => ({ recordPinSaved: jest.fn(async () => {}) }));
jest.mock('../enrich/ogMetadata', () => ({
  fetchOGMetadata: jest.fn(), isGoogleMapsUrl: () => false,
  parseGoogleMapsUrl: jest.fn(), resolveShortUrl: jest.fn(),
}));
jest.mock('../enrich/ai', () => ({
  aiExtractPlaces: jest.fn(), aiExtractPlace: jest.fn(async () => ''), aiVerifyPlace: jest.fn(),
}));
jest.mock('../enrich/places', () => ({
  searchGooglePlaces: jest.fn(), getPlaceDetails: jest.fn(async () => null), findPlaceFromUrl: jest.fn(),
}));

const { firestore: db } = require('../lib/firestore');
const { runEnrichment } = require('../enrich');
const { admitEnrichmentJob } = require('../lib/enrichAdmission');
const { createWorker } = require('../lib/enrichmentWorker');
const { createEngineFeatures } = require('../lib/engineFeatures');
const { identities, indexRows } = require('../functions/lib/contentIdentity');
const { runYtDlp } = require('../lib/ytdlp');
const { fetchOGMetadata } = require('../enrich/ogMetadata');
const { aiExtractPlaces } = require('../enrich/ai');
const { searchGooglePlaces } = require('../enrich/places');

const UID = 'fixture-owner';
const POST = 'https://www.tiktok.com/@fixture/video/7300000000000000001';
const OLD = 'https://www.tiktok.com/@fixture/video/7300000000000000002';
const places = ['Ramen Spot', 'Taco Stand', 'Coffee House'].map((name, i) => ({
  place_id: `place-${i}`, name, types: ['restaurant'],
  formatted_address: `${i + 1} Main St, New York, NY, USA`,
  geometry: { location: { lat: 40.7 + i / 100, lng: -74 } },
}));
const evidence = places.map(p => ({ name: p.name, city: 'New York', address: '' }));
const config = flags => createEngineFeatures({ internalUids: [UID], flags });

function seedIndexedPin(primaryUrl = POST) {
  const pin = { userId: UID, placeId: places[0].place_id, placeName: places[0].name,
    url: primaryUrl, sources: [{ url: POST, sourceApp: 'tiktok' }] };
  db.seed('pins', 'indexed-ramen', pin);
  for (const row of indexRows(UID, 'indexed-ramen', identities(pin))) db.seed('pinContentIndex', row.id, row);
  db.seed('accountingAccounts', UID, { indexReady: true });
  return pin;
}

async function execute(jobId, { url = POST, flags = { contentIndexReader: true }, retryOf, liveFlags = {} } = {}) {
  const admission = await admitEnrichmentJob(db, { jobId, userId: UID, url, retryOf }, { features: config(flags) });
  expect(admission.code).toBe(202);
  // The worker must execute the admitted snapshot even after an operator changes rollout.
  process.env.ENGINE_ROLLOUT_JSON = JSON.stringify({ rolloutPercent: 100, flags: liveFlags });
  const worker = createWorker({ db, runEnrichment });
  await worker.tick();
  await worker.idle();
  return db.read('enrichmentJobs', jobId);
}

beforeEach(() => {
  db.reset(); db.strictReadOrder = true;
  jest.clearAllMocks();
  process.env.ENGINE_ROLLOUT_JSON = '{}';
  runYtDlp.mockResolvedValue({ title: 'New York food tour', description: 'Ramen Spot and Taco Stand in New York', webpage_url: POST });
  fetchOGMetadata.mockResolvedValue({ title: 'Ramen Spot', description: 'Ramen Spot in New York', image: '' });
  aiExtractPlaces.mockResolvedValue({ places: evidence.slice(0, 2) });
  searchGooglePlaces.mockImplementation(async query => places.filter(p => query.includes(p.name)));
});

test('blocked subtitle evidence cannot be reported as a confirmed absence of venues', async () => {
  const url = 'https://www.youtube.com/watch?v=blockedSubtitleFixture';
  runYtDlp.mockResolvedValue({ title: 'A day out', description: '', webpage_url: url, subtitles: null,
    subtitle_tracks: [], subtitle_failures: [{ code: 'access_blocked', stage: 'subtitles', provider: 'youtube', language: 'ja' }] });
  aiExtractPlaces.mockResolvedValue({ places: [] });
  searchGooglePlaces.mockResolvedValue([]);
  const result = await execute('blocked-subtitle-job', { url, flags: { languageRouting: true, contentIndexReader: true } });
  expect(result).toMatchObject({ status: 'failed', failure: { code: 'access_blocked', stage: 'subtitles' } });
  expect(db.read('engineMetrics', 'blocked-subtitle-job')).toMatchObject({ outcome: 'blocked' });
  expect([...db.collections.get('pins')?.values() || []]).toHaveLength(0);
});

test('failed source attachment does not acknowledge later unattempted attachments as saved', async () => {
  const original=seedIndexedPin(OLD);
  db.seed('pins','indexed-ramen',{...original,sources:[]});
  db.seed('pins','second-existing',{...original,placeId:places[1].place_id,placeName:places[1].name,sources:[]});
  db.setWriteFailure(collection=>collection==='pins'?new Error('temporary write outage'):null);
  const job=await execute('source-outage');
  expect(job).toMatchObject({status:'failed',progress:{saved:0,total:2}});
  expect(job.outcomes.every(outcome=>outcome.status==='unresolved')).toBe(true);
  expect(db.read('pins','indexed-ramen').sources).toEqual([]);
  expect(db.read('pins','second-existing').sources).toEqual([]);
});

test.each([POST, OLD])('F2: one indexed venue (primary URL %s) does not suppress matching or saving the second', async primaryUrl => {
  const existing = seedIndexedPin(primaryUrl);
  const job = await execute('multi-place');
  expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
  expect(searchGooglePlaces.mock.calls.map(([query]) => query)).toEqual(['Ramen Spot New York', 'Taco Stand New York']);
  const savedPins = await db.collection('pins').get();
  expect({ status: job.status, progress: job.progress,
    placeIds: savedPins.docs.map(doc => doc.data().placeId).sort() }).toEqual({
    status: 'complete', progress: { saved: 2, total: 2 }, placeIds: ['place-0', 'place-1'],
  });
  expect(job.outcomes).toEqual([
    expect.objectContaining({ name: 'Ramen Spot', status: 'existing', pinId: 'indexed-ramen' }),
    expect.objectContaining({ name: 'Taco Stand', status: 'saved', pinId: job.pinId }),
  ]);
  expect(job.pinId).not.toBe('indexed-ramen');
  expect(db.read('pins', job.pinId)).toMatchObject({ userId: UID, placeId: 'place-1', url: POST, sources: [expect.objectContaining({ url: POST })] });
  expect(db.read('pins', 'indexed-ramen').sources).toEqual(existing.sources);
  expect((await db.collection('pins').get()).size).toBe(2);
});

test('F2: partial retry retains the indexed and newly saved outcomes and resolves only the remaining venue', async () => {
  // Keep the indexed source attached, so this also covers membership via sources[].
  seedIndexedPin(OLD);
  runYtDlp.mockResolvedValue({ title: 'New York food tour',
    description: 'Ramen Spot, Taco Stand and Coffee House in New York', webpage_url: POST });
  aiExtractPlaces.mockResolvedValue({ places: evidence });
  searchGooglePlaces.mockImplementation(async query => places.slice(0, 2).filter(p => query.includes(p.name)));
  const parent = await execute('partial');
  expect(parent).toMatchObject({ status: 'failed', failure: { code: 'partial_save' }, progress: { saved: 2, total: 3 } });
  const preserved = parent.outcomes.filter(o => ['saved', 'existing'].includes(o.status));
  const beforePins = (await db.collection('pins').get()).docs.map(doc => ({ id: doc.id, data: doc.data() }));
  expect(beforePins).toHaveLength(2);
  jest.clearAllMocks();
  searchGooglePlaces.mockResolvedValue([places[2]]);
  const child = await execute('retry', { retryOf: 'partial' });
  expect(runYtDlp).not.toHaveBeenCalled();
  expect(aiExtractPlaces).not.toHaveBeenCalled();
  expect(searchGooglePlaces.mock.calls).toEqual([['Coffee House New York']]);
  expect(child).toMatchObject({ status: 'complete', progress: { saved: 3, total: 3 } });
  expect(child.outcomes.slice(0, 2)).toEqual(preserved);
  expect(child.outcomes[2]).toMatchObject({ name: 'Coffee House', status: 'saved', pinId: child.pinId });
  for (const pin of beforePins) expect(db.read('pins', pin.id)).toEqual(pin.data);
  expect(db.read('enrichmentJobs', 'partial')).toEqual(parent);
  expect((await db.collection('pins').get()).size).toBe(3);

  // A delivery retry after completion must keep the same results without redoing providers.
  jest.clearAllMocks();
  const redelivery = await admitEnrichmentJob(db, { jobId: 'retry', userId: UID, url: POST, retryOf: 'partial' },
    { features: config({ contentIndexReader: false }) });
  expect(redelivery.body.status).toBe('complete');
  const worker = createWorker({ db, runEnrichment });
  await worker.tick(); await worker.idle();
  expect(db.read('enrichmentJobs', 'retry')).toEqual(child);
  expect((await db.collection('pins').get()).size).toBe(3);
  expect(searchGooglePlaces).not.toHaveBeenCalled();
  expect(aiExtractPlaces).not.toHaveBeenCalled();
  expect(runYtDlp).not.toHaveBeenCalled();
});

test.each(['reused','deleted'])('F2: a matched pin that is %s cannot be modified or acknowledged as saved', async mode => {
  seedIndexedPin();
  aiExtractPlaces.mockResolvedValue({ places: evidence.slice(0, 1) });
  const collectionSpy = jest.spyOn(db, 'collection');
  const foreign = { userId: 'foreign-owner', placeId: 'place-0', placeName: 'Private venue', url: OLD,
    sources: [{ url: OLD, ogTitle: 'Private source' }] };
  let reused = false;
  const transact = db.runTransaction.bind(db);
  const transactionSpy = jest.spyOn(db, 'runTransaction').mockImplementation(work => {
    if (!reused && searchGooglePlaces.mock.calls.length) {
      expect(collectionSpy).toHaveBeenCalledWith('pinContentIndex');
      expect(searchGooglePlaces).toHaveBeenCalledWith('Ramen Spot New York');
      // Concurrent mutation commits before this transaction; an abort must not
      // roll it back as if it were part of the append transaction under test.
      reused = true;
      if(mode==='reused') db.seed('pins', 'indexed-ramen', foreign);
      else db.collections.get('pins').delete('indexed-ramen');
    }
    return transact(work);
  });
  const rowsBefore = (await db.collection('pinContentIndex').get()).docs.map(doc => doc.data());
  try {
    const job = await execute('owner-race');
    expect(reused).toBe(true);
    expect(db.read('pins', 'indexed-ramen')).toEqual(mode==='reused'?foreign:undefined);
    expect(job).toMatchObject({status:'failed',progress:{saved:0,total:1},outcomes:[{status:'unresolved'}]});
    expect(job.existingPinId).toBeUndefined();
    expect(job.sourceAdded).not.toBe(true);
    expect((await db.collection('pinContentIndex').get()).docs.map(doc => doc.data())).toEqual(rowsBefore);
  } finally { collectionSpy.mockRestore(); transactionSpy.mockRestore(); }
});

test('F2 off preserves legacy whole-link dedup even if the live rollout is enabled', async () => {
  seedIndexedPin();
  const job = await execute('legacy', { flags: { contentIndexReader: false }, liveFlags: { contentIndexReader: true } });
  expect(job).toMatchObject({ status: 'duplicate', existingPinId: 'indexed-ramen', sourceAdded: false });
  expect(runYtDlp).not.toHaveBeenCalled();
  expect(aiExtractPlaces).not.toHaveBeenCalled();
  expect(searchGooglePlaces).not.toHaveBeenCalled();
  expect((await db.collection('pins').get()).size).toBe(1);
});

test.each([
  ['https://www.youtube.com/watch?v=fixture123', true],
  ['https://youtu.be/fixture123', true],
  ['https://m.youtube.com/shorts/fixture123', true],
  ['https://www.youtube.com/watch?v=fixture123', false],
])('F6: %s with captured languageRouting=%s ignores the opposite live configuration', async (url, enabled) => {
  runYtDlp.mockResolvedValue({ title: 'Ramen Spot', description: 'Ramen Spot in New York', webpage_url: url,
    subtitles: '喫茶 月光', subtitle_tracks: [{ language: 'ja', text: '喫茶 月光', provenance: { original: true } }] });
  aiExtractPlaces.mockResolvedValue({ places: evidence.slice(0, 1) });
  const job = await execute('youtube', { url, flags: { languageRouting: enabled }, liveFlags: { languageRouting: !enabled } });
  expect(job.status).toBe('complete');
  if (enabled) {
    expect(runYtDlp).toHaveBeenCalledWith(url, expect.objectContaining({ multilingual: true }));
    expect(fetchOGMetadata).not.toHaveBeenCalled();
    expect(aiExtractPlaces).toHaveBeenCalledWith(expect.objectContaining({ subtitles: '喫茶 月光',
      subtitleTracks: [{ language: 'ja', provenance: { original: true } }] }), expect.objectContaining({ scope: require('../lib/sharedAiIdentity').SERVER_PUBLIC_SCOPE }));
  } else {
    expect(runYtDlp).not.toHaveBeenCalled();
    expect(fetchOGMetadata).toHaveBeenCalledWith(url);
    expect(aiExtractPlaces).toHaveBeenCalledWith(expect.objectContaining({ subtitleTracks: [] }), expect.objectContaining({ scope: `user:${UID}` }));
  }
  expect(db.read('pins', job.pinId)).toMatchObject({ sourceApp: 'youtube', url });
});

test.each([
  'https://youtube.com.evil.example/watch?v=fixture123',
  'https://evil.example/youtube.com/watch?v=fixture123',
  'https://music.youtube.com/watch?v=fixture123',
  'https://www.youtube.com/@fixture',
  'https://www.youtube.com/redirect?q=https://evil.example',
])('F6: enabling language routing adds no social extractor route for %s', async url => {
  aiExtractPlaces.mockResolvedValue({ places: evidence.slice(0, 1) });
  const job = await execute('non-video', { url, flags: { languageRouting: true } });
  expect(job.status).toBe('complete');
  expect(fetchOGMetadata).toHaveBeenCalledWith(url);
  expect(runYtDlp).not.toHaveBeenCalled();
  expect(aiExtractPlaces).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ scope: `user:${UID}` }));
});
