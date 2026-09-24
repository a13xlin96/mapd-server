// S5 interest-profile-server-side plan, Task 2: server-saved pins (the
// cloud-function-driven /enrich pipeline) get NO client-side
// updateInterestProfile call — enrichmentService.ts's processUrl (which
// contains the client's only updateInterestProfile calls) only runs on the
// client's local-fallback pipeline, which the standard server path always
// skips. So runEnrichment must call recordPinSaved itself after a
// successful NEW-pin write, and must NOT call it on a duplicate-skip (that
// would double count against a pin that already bumped totalPins).
//
// Mocks recordPinSaved directly (rather than firestore's users/.../
// interestProfile/latest doc) since the shared fakeFirestore test helper
// used across the other runEnrichment tests doesn't model subcollections.

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

const mockRecordPinSaved = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/interestProfile', () => ({ recordPinSaved: mockRecordPinSaved }));

jest.mock('../lib/thumbnails', () => ({
  persistThumbnail: jest.fn(async raw => raw ? 'https://firebasestorage.googleapis.com/hosted-thumb' : ''),
}));

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
  isGoogleMapsUrl: () => false,
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
const { aiExtractPlaces } = require('../enrich/ai');
const { searchGooglePlaces, getPlaceDetails } = require('../enrich/places');
const { runEnrichment } = require('../enrich');

const fs = getSharedFirestore();

const USER = 'u_interest';
const SHORT_URL = 'https://www.tiktok.com/t/ZTShortInterest/';
const CANONICAL = 'https://www.tiktok.com/@foodie/video/7300000000000000099';

const RAMEN_PLACE = {
  place_id: 'P_ramen_ip',
  name: 'Ramen Spot',
  formatted_address: '1 Main St, Austin, TX, USA',
  types: ['restaurant'],
  geometry: { location: { lat: 30.27, lng: -97.74 } },
};

function seedJob(jobId, url = SHORT_URL) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'processing',
    userId: USER,
    url,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 5000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 1000),
  });
}

beforeEach(() => {
  fs.reset();
  jest.clearAllMocks();
  getPlaceDetails.mockResolvedValue(null);
});

test('NEW pin from the single-candidate AI path calls recordPinSaved with the pin category/city/country', async () => {
  seedJob('job_new');

  runYtDlp.mockResolvedValue({
    title: 'a ramen video',
    description: 'Ramen Spot in Austin',
    webpage_url: CANONICAL,
    thumbnail_url: 'https://p16.tiktokcdn.com/expiring.jpg',
    hashtags: [],
    uploader: 'foodie',
    subtitles: '',
  });
  aiExtractPlaces.mockResolvedValue({ places: [{ name: 'Ramen Spot', city: 'Austin', address: '' }] });
  searchGooglePlaces.mockResolvedValue([RAMEN_PLACE]);
  getPlaceDetails.mockResolvedValue({
    types: ['restaurant'],
    formatted_address: '1 Main St, Austin, TX, USA',
    geometry: { location: { lat: 30.27, lng: -97.74 } },
  });

  await runEnrichment('job_new', SHORT_URL, USER, '');

  const job = fs.read('enrichmentJobs', 'job_new');
  expect(job.status).toBe('complete');
  const pin = fs.read('pins', job.pinId);
  expect(pin.ogImage).toBe('https://firebasestorage.googleapis.com/hosted-thumb');
  expect(pin.sources[0].ogImage).toBe(pin.ogImage);
  expect(require('../lib/thumbnails').persistThumbnail).toHaveBeenCalledWith(
    'https://p16.tiktokcdn.com/expiring.jpg', CANONICAL,
  );

  expect(mockRecordPinSaved).toHaveBeenCalledTimes(1);
  const [uid, payload] = mockRecordPinSaved.mock.calls[0];
  expect(uid).toBe(USER);
  expect(payload.city).toBe('Austin');
  expect(payload.country).toBeDefined();
  expect(typeof payload.category).toBe('string');
});

test('duplicate (already-pinned place) does NOT call recordPinSaved — no double count', async () => {
  seedJob('job_dup');
  fs.seed('pins', 'pin_ramen_ip', {
    userId: USER,
    url: 'https://www.tiktok.com/@chef/video/7300000000000000001',
    placeId: 'P_ramen_ip',
    placeName: 'Ramen Spot',
    category: 'food',
    city: 'Austin',
    country: 'US',
    sources: [
      {
        url: 'https://www.tiktok.com/@chef/video/7300000000000000001',
        ogTitle: 'first video', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0),
      },
    ],
  });

  runYtDlp.mockResolvedValue({
    title: 'another ramen video',
    description: 'Ramen Spot in Austin',
    webpage_url: CANONICAL,
    thumbnail_url: '',
    hashtags: [],
    uploader: 'foodie',
    subtitles: '',
  });
  aiExtractPlaces.mockResolvedValue({ places: [{ name: 'Ramen Spot', city: 'Austin', address: '' }] });
  searchGooglePlaces.mockResolvedValue([RAMEN_PLACE]);

  await runEnrichment('job_dup', SHORT_URL, USER, '');

  const job = fs.read('enrichmentJobs', 'job_dup');
  expect(job.status).toBe('duplicate');
  expect(mockRecordPinSaved).not.toHaveBeenCalled();
});

test('a recordPinSaved rejection never fails the job (fire-and-forget)', async () => {
  seedJob('job_reject');
  mockRecordPinSaved.mockRejectedValueOnce(new Error('profile write boom'));

  runYtDlp.mockResolvedValue({
    title: 'a ramen video',
    description: 'Ramen Spot in Austin',
    webpage_url: CANONICAL,
    thumbnail_url: '',
    hashtags: [],
    uploader: 'foodie',
    subtitles: '',
  });
  aiExtractPlaces.mockResolvedValue({ places: [{ name: 'Ramen Spot', city: 'Austin', address: '' }] });
  searchGooglePlaces.mockResolvedValue([RAMEN_PLACE]);
  getPlaceDetails.mockResolvedValue({
    types: ['restaurant'],
    formatted_address: '1 Main St, Austin, TX, USA',
    geometry: { location: { lat: 30.27, lng: -97.74 } },
  });

  await runEnrichment('job_reject', SHORT_URL, USER, '');

  const job = fs.read('enrichmentJobs', 'job_reject');
  expect(job.status).toBe('complete');
});
