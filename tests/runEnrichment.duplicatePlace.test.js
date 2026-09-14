// Each test supplies a different synthetic post for the same URL; isolate its cache.
jest.mock('../lib/cache',()=>({...jest.requireActual('../lib/cache'),getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})}));
// End-to-end runEnrichment coverage for the "unique video about an
// already-pinned place" bug: the server used to mark the job 'duplicate'
// and drop the new link entirely. New contract:
//   - place-ID duplicate → new video's canonical URL appended to the
//     existing pin's sources[], job carries sourceAdded:true, push says so
//   - same-video reshare (content-ID dup) → no append, sourceAdded:false
//   - all AI candidates already pinned → NO fall-through to the OG fallback
//     (it would re-run AI + Places for places we already matched)
//   - mixed new/existing candidates → existing pins get the source appended

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

jest.mock('../lib/ytdlp', () => ({ runYtDlp: jest.fn() }));
jest.mock('../lib/tiktokPhoto', () => ({
  fetchTikTokPhotoPost: jest.fn(),
  isTikTokPhotoUrl: () => false,
}));
jest.mock('../lib/instagramCarousel', () => ({
  fetchInstagramCarouselPost: jest.fn(),
  isInstagramPostUrl: () => false,
}));
jest.mock('../lib/instagramReel', () => ({
  fetchInstagramReelPost: jest.fn(),
  isInstagramReelUrl: () => false,
}));
jest.mock('../lib/vision', () => ({
  extractPlacesFromSlides: jest.fn().mockResolvedValue({ places: [] }),
}));
jest.mock('../lib/urlResolve', () => ({
  resolveOneRedirect: jest.fn(async (u) => u),
  isShortSocialUrl: () => false,
}));
jest.mock('../enrich/ogMetadata', () => ({
  fetchOGMetadata: jest.fn().mockResolvedValue({ title: '', description: '', image: '' }),
  resolveShortUrl: jest.fn(async (u) => u),
  isGoogleMapsUrl: (u) => u.includes('google.com/maps') || u.includes('maps.app.goo.gl'),
  parseGoogleMapsUrl: jest.fn(() => null),
}));
jest.mock('../enrich/ai', () => ({
  aiExtractPlaces: jest.fn(),
  aiExtractPlace: jest.fn().mockResolvedValue(''),
  aiVerifyPlace: jest.fn().mockResolvedValue({ match: true }),
}));
jest.mock('../enrich/places', () => ({
  searchGooglePlaces: jest.fn(),
  getPlaceDetails: jest.fn(),
  findPlaceFromUrl: jest.fn().mockResolvedValue(null),
}));
jest.mock('../lib/push', () => ({
  sendPush: jest.fn(),
  sendPushForJob: jest.fn().mockResolvedValue(undefined),
  dispatchPush: jest.fn(),
  recordPushDelivery: jest.fn(),
}));

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { runYtDlp } = require('../lib/ytdlp');
const { aiExtractPlaces, aiExtractPlace } = require('../enrich/ai');
const { searchGooglePlaces, getPlaceDetails } = require('../enrich/places');
const { sendPushForJob } = require('../lib/push');
const { runEnrichment } = require('../enrich');

const fs = getSharedFirestore();

const USER = 'u_dup';
const VIDEO_A = 'https://www.tiktok.com/@chef/video/7300000000000000001';
const VIDEO_B = 'https://www.tiktok.com/@foodie/video/7300000000000000002';
const SHORT_B = 'https://www.tiktok.com/t/ZTShortBbb/';

const RAMEN_PLACE = {
  place_id: 'P_ramen',
  name: 'Ramen Spot',
  formatted_address: '1 Main St, New York, NY, USA',
  types: ['restaurant'],
  geometry: { location: { lat: 40.7, lng: -74.0 } },
};
const TACO_PLACE = {
  place_id: 'P_taco',
  name: 'Taco Stand',
  formatted_address: '2 Side St, New York, NY, USA',
  types: ['restaurant'],
  geometry: { location: { lat: 40.71, lng: -74.01 } },
};

function seedJob(jobId) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'processing',
    userId: USER,
    url: SHORT_B,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 5000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 1000),
  });
}

function seedRamenPin() {
  fs.seed('pins', 'pin_ramen', {
    userId: USER,
    url: VIDEO_A,
    placeId: 'P_ramen',
    placeName: 'Ramen Spot',
    sources: [
      { url: VIDEO_A, ogTitle: 'first video', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
    ],
  });
}

beforeEach(() => {
  fs.reset();
  jest.clearAllMocks();
  getPlaceDetails.mockResolvedValue(null);
});

describe('runEnrichment — place already pinned, NEW video', () => {
  test('appends the canonical URL to the existing pin and flags sourceAdded', async () => {
    seedJob('job1');
    seedRamenPin();

    // yt-dlp resolves the short share URL to video B's canonical URL.
    runYtDlp.mockResolvedValue({
      title: 'another ramen video',
      description: 'Ramen Spot in NYC',
      webpage_url: VIDEO_B,
      thumbnail_url: 'https://img.example/b.jpg',
      hashtags: [],
      uploader: 'foodie',
      subtitles: '',
    });
    aiExtractPlaces.mockResolvedValue({ places: [{ name: 'Ramen Spot', city: 'New York', address: '' }] });
    searchGooglePlaces.mockResolvedValue([RAMEN_PLACE]);

    await runEnrichment('job1', SHORT_B, USER, '');

    const job = fs.read('enrichmentJobs', 'job1');
    expect(job.status).toBe('duplicate');
    expect(job.existingPinId).toBe('pin_ramen');
    expect(job.sourceAdded).toBe(true);

    const pin = fs.read('pins', 'pin_ramen');
    expect(pin.sources).toHaveLength(2);
    expect(pin.sources[1].url).toBe(VIDEO_B);

    // The all-candidates-existing case must NOT re-run the OG fallback.
    expect(aiExtractPlace).not.toHaveBeenCalled();

    expect(sendPushForJob).toHaveBeenCalledWith(
      'job1', USER, 'duplicate',
      expect.objectContaining({ placeName: 'Ramen Spot', pinId: 'pin_ramen', sourceAdded: true }),
    );
  });

  test('same-video reshare (content-ID dup) does not append or claim a new link', async () => {
    seedJob('job2');
    seedRamenPin();

    // Different short URL, same canonical video A.
    runYtDlp.mockResolvedValue({
      title: 'same video again',
      description: '',
      webpage_url: VIDEO_A,
      thumbnail_url: '',
      hashtags: [],
      uploader: 'chef',
      subtitles: '',
    });

    await runEnrichment('job2', 'https://www.tiktok.com/t/ZTOtherShort/', USER, '');

    const job = fs.read('enrichmentJobs', 'job2');
    expect(job.status).toBe('duplicate');
    expect(job.sourceAdded).toBe(false);
    expect(fs.read('pins', 'pin_ramen').sources).toHaveLength(1);
    // Content-ID dedup fires before AI — no AI or Places calls at all.
    expect(aiExtractPlaces).not.toHaveBeenCalled();

    expect(sendPushForJob).toHaveBeenCalledWith(
      'job2', USER, 'duplicate',
      expect.objectContaining({ pinId: 'pin_ramen', sourceAdded: false }),
    );
  });

  test('mixed candidates: existing pin gets the source, new place goes to selection', async () => {
    seedJob('job3');
    seedRamenPin();

    runYtDlp.mockResolvedValue({
      title: 'ramen and tacos tour',
      description: 'Ramen Spot and Taco Stand in New York',
      webpage_url: VIDEO_B,
      thumbnail_url: '',
      hashtags: [],
      uploader: 'foodie',
      subtitles: '',
    });
    aiExtractPlaces.mockResolvedValue({
      places: [
        { name: 'Ramen Spot', city: 'New York', address: '' },
        { name: 'Taco Stand', city: 'New York', address: '' },
      ],
    });
    searchGooglePlaces.mockImplementation(async (query) =>
      query.includes('Ramen') ? [RAMEN_PLACE] : [TACO_PLACE]);
    getPlaceDetails.mockResolvedValue({
      types: ['restaurant'],
      formatted_address: '2 Side St, New York, NY, USA',
      geometry: { location: { lat: 40.71, lng: -74.01 } },
    });

    await runEnrichment('job3', SHORT_B, USER, '');

    // Existing ramen pin got video B appended even though the job went to selection.
    const pin = fs.read('pins', 'pin_ramen');
    expect(pin.sources).toHaveLength(2);
    expect(pin.sources[1].url).toBe(VIDEO_B);

    // job completed as a single-candidate save or needs_selection depending
    // on how many NEW places remain — here exactly one new place, so the
    // server saves it directly (mirrors candidates.length === 1 branch).
    const job = fs.read('enrichmentJobs', 'job3');
    expect(['complete', 'needs_selection']).toContain(job.status);
  });

  test('existing match + unresolved place retains a partial result and its source link', async () => {
    // Codex P3: candidates.length === 0 can also mean "Places couldn't
    // resolve a name", not "everything already pinned". The OG fallback must
    // still get its shot at the unresolved place; but if it comes up empty,
    // the job must finish as duplicate (the share DID land on the existing
    // pin) — not as a scary 'failed'.
    seedJob('job4');
    seedRamenPin();

    runYtDlp.mockResolvedValue({
      title: 'ramen and a mystery spot',
      description: 'Ramen Spot in New York and Mystery Cafe in Nowhere',
      webpage_url: VIDEO_B,
      thumbnail_url: '',
      hashtags: [],
      uploader: 'foodie',
      subtitles: '',
    });
    aiExtractPlaces.mockResolvedValue({
      places: [
        { name: 'Ramen Spot', city: 'New York', address: '' },
        { name: 'Mystery Cafe', city: 'Nowhere', address: '' },
      ],
    });
    // Ramen resolves to the existing pin; Mystery Cafe gets no results.
    searchGooglePlaces.mockImplementation(async (query) =>
      query.includes('Ramen') ? [RAMEN_PLACE] : []);
    // OG fallback's single-place inference also dead-ends.
    aiExtractPlace.mockResolvedValue('');

    await runEnrichment('job4', SHORT_B, USER, '');

    // The parsed empty result is reused; fallback does not spend on another AI call.
    expect(aiExtractPlace).not.toHaveBeenCalled();

    // The source was saved, but the unresolved place must stay actionable.
    const job = fs.read('enrichmentJobs', 'job4');
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('partial_save');
    expect(job.progress).toEqual({saved:1,total:2});
    expect(job.sourceAdded).toBe(true);
    expect(fs.read('pins', 'pin_ramen').sources).toHaveLength(2);

    expect(sendPushForJob).toHaveBeenCalledWith(
      'job4', USER, 'duplicate',
      expect.objectContaining({ pinId: 'pin_ramen', sourceAdded: true }),
    );
  });

  test('race on the lone new candidate still reports the pin that received the link', async () => {
    // Codex round-2 P3s: ramen is existing (gets the source appended); the
    // taco place passes the loop's dedup check but is saved concurrently
    // (another device) before writePinTransactional runs — its txn returns
    // alreadyExists + sourceAdded:false. The job must still report
    // sourceAdded:true AND point existingPinId at the pin that actually
    // received the link (ramen), not the raced taco pin.
    seedJob('job5');
    seedRamenPin();

    runYtDlp.mockResolvedValue({
      title: 'ramen and tacos tour',
      description: 'Ramen Spot and Taco Stand in New York',
      webpage_url: VIDEO_B,
      thumbnail_url: '',
      hashtags: [],
      uploader: 'foodie',
      subtitles: '',
    });
    aiExtractPlaces.mockResolvedValue({
      places: [
        { name: 'Ramen Spot', city: 'New York', address: '' },
        { name: 'Taco Stand', city: 'New York', address: '' },
      ],
    });
    searchGooglePlaces.mockImplementation(async (query) =>
      query.includes('Ramen') ? [RAMEN_PLACE] : [TACO_PLACE]);
    // Simulate the concurrent save: by the time details are fetched (after
    // the loop's findPinByPlaceId check), the taco pin exists with this
    // exact share already as its url.
    getPlaceDetails.mockImplementation(async () => {
      if (!fs.read('pins', 'pin_taco')) {
        fs.seed('pins', 'pin_taco', {
          userId: USER,
          url: VIDEO_B,
          placeId: 'P_taco',
          placeName: 'Taco Stand',
          sources: [
            { url: VIDEO_B, ogTitle: '', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
          ],
        });
      }
      return {
        types: ['restaurant'],
        formatted_address: '2 Side St, New York, NY, USA',
        geometry: { location: { lat: 40.71, lng: -74.01 } },
      };
    });

    await runEnrichment('job5', SHORT_B, USER, '');

    expect(fs.read('pins', 'pin_ramen').sources).toHaveLength(2);

    const job = fs.read('enrichmentJobs', 'job5');
    expect(job.status).toBe('duplicate');
    expect(job.sourceAdded).toBe(true);
    expect(job.existingPinId).toBe('pin_ramen');

    expect(sendPushForJob).toHaveBeenCalledWith(
      'job5', USER, 'duplicate',
      expect.objectContaining({ pinId: 'pin_ramen', sourceAdded: true }),
    );
  });
});


test('explicit partial retry bypasses whole-link dedup but keeps place-ID dedup',async()=>{
  seedJob('partial');
  runYtDlp.mockResolvedValue({title:'Ramen and tacos',description:'Ramen Spot and Taco Stand in New York',webpage_url:VIDEO_B});
  aiExtractPlaces.mockResolvedValue({places:[{name:'Ramen Spot',city:'New York'},{name:'Taco Stand',city:'New York'}]});
  searchGooglePlaces.mockImplementation(async q=>q.includes('Ramen')?[RAMEN_PLACE]:[]);
  await runEnrichment('partial',SHORT_B,USER,'');
  const parent=fs.read('enrichmentJobs','partial');
  expect(parent.failure.code).toBe('partial_save');expect(parent.progress).toEqual({saved:1,total:2});
  fs.seed('enrichmentJobs','retry',{status:'processing',userId:USER,url:SHORT_B,retryOf:'partial'});
  aiExtractPlaces.mockClear();runYtDlp.mockClear();
  searchGooglePlaces.mockResolvedValue([TACO_PLACE]);
  await runEnrichment('retry',SHORT_B,USER,'');
  expect(aiExtractPlaces).not.toHaveBeenCalled();expect(runYtDlp).not.toHaveBeenCalled();
  const child=fs.read('enrichmentJobs','retry');
  expect(child.status).toBe('complete');expect(child.progress).toEqual({saved:2,total:2});
  expect(child.pinId).not.toBe(parent.pinId);
});
test('another account cannot resume a private parent job',async()=>{
  fs.seed('enrichmentJobs','private-parent',{userId:'other',url:VIDEO_B,status:'failed',outcomes:[{name:'Secret Cafe',status:'unresolved'}]});
  fs.seed('enrichmentJobs','attacker',{userId:USER,url:VIDEO_B,status:'processing',retryOf:'private-parent'});
  aiExtractPlaces.mockClear();
  await runEnrichment('attacker',VIDEO_B,USER,'');
  expect(fs.read('enrichmentJobs','attacker').failure.code).toBe('access_blocked');
  expect(aiExtractPlaces).not.toHaveBeenCalled();
});

test('an uncertain tag match on an already saved place still requires selection before source attachment',async()=>{
  seedJob('tag-existing');seedRamenPin();
  runYtDlp.mockResolvedValue({title:'Dinner',description:'Dinner @ramenspot in New York',webpage_url:VIDEO_B});
  aiExtractPlaces.mockResolvedValue({places:[{name:'Ramen Spot',city:'New York',source:'handle',handle:'ramenspot'}]});
  searchGooglePlaces.mockResolvedValue([RAMEN_PLACE]);
  await runEnrichment('tag-existing',SHORT_B,USER,'');
  expect(fs.read('enrichmentJobs','tag-existing').status).toBe('needs_selection');
  expect(fs.read('pins','pin_ramen').sources).toHaveLength(1);
});
