// New pins must store the CANONICAL video URL (yt-dlp webpage_url), not the
// raw shared short URL. TikTok mints a unique /t/XXXX short URL on every
// share and those carry no extractable content ID — a pin created with one
// can never be content-ID-matched, so the same video reshared would re-run
// the whole AI + Places pipeline and look like a "new link". The legacy
// client pipeline stored canonical; the server pipeline lost that in the
// cloud-function migration.

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

const USER = 'u_canon';
const SHORT_URL = 'https://www.tiktok.com/t/ZTShortNew/';
const CANONICAL = 'https://www.tiktok.com/@foodie/video/7300000000000000009';

beforeEach(() => {
  fs.reset();
  jest.clearAllMocks();
});

test('new pin stores the canonical URL, not the shared short URL', async () => {
  fs.seed('enrichmentJobs', 'job_c1', {
    status: 'processing',
    userId: USER,
    url: SHORT_URL,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 5000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 1000),
  });

  runYtDlp.mockResolvedValue({
    title: 'hidden taco gem',
    description: 'Taco Stand in NYC',
    webpage_url: CANONICAL,
    thumbnail_url: '',
    hashtags: [],
    uploader: 'foodie',
    subtitles: '',
  });
  aiExtractPlaces.mockResolvedValue({ places: [{ name: 'Taco Stand', city: 'New York', address: '' }] });
  searchGooglePlaces.mockResolvedValue([{
    place_id: 'P_taco',
    name: 'Taco Stand',
    formatted_address: '2 Side St, New York, NY, USA',
    types: ['restaurant'],
    geometry: { location: { lat: 40.71, lng: -74.01 } },
  }]);
  getPlaceDetails.mockResolvedValue({
    types: ['restaurant'],
    formatted_address: '2 Side St, New York, NY, USA',
    geometry: { location: { lat: 40.71, lng: -74.01 } },
  });

  await runEnrichment('job_c1', SHORT_URL, USER, '');

  const job = fs.read('enrichmentJobs', 'job_c1');
  expect(job.status).toBe('complete');

  const pin = fs.read('pins', job.pinId);
  expect(pin.url).toBe(CANONICAL);
  expect(pin.sources).toHaveLength(1);
  expect(pin.sources[0].url).toBe(CANONICAL);
});
