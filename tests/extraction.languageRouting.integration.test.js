// Real extraction, source cache, yt-dlp metadata handling and subtitle parser;
// only external subprocess, DNS and HTTP providers are replaced.
const originalEnv = process.env;
process.env = { NODE_ENV: 'test' };
afterAll(() => { process.env = originalEnv; });

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));
jest.mock('../lib/tiktokPhoto', () => ({ isTikTokPhotoUrl: () => false }));
jest.mock('../lib/instagramCarousel', () => ({ isInstagramPostUrl: () => false }));
jest.mock('../lib/instagramReel', () => ({ isInstagramReelUrl: () => false }));
jest.mock('../lib/urlResolve', () => ({ isShortSocialUrl: () => false, resolveOneRedirect: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const axios = require('axios');
const { lookup } = require('dns').promises;
const { extractPublicPost, extractionKey } = require('../lib/extraction');
const { getCached } = require('../lib/cache');
const { createEngineFeatures } = require('../lib/engineFeatures');
const jobContext = require('../lib/jobContext');

const nativeText = '喫茶 月光 京都';
const englishText = 'Moonlight Cafe Kyoto';
const nativeTrack = 'https://www.youtube.com/api/timedtext?lang=ja';
const englishTrack = 'https://www.youtube.com/api/timedtext?lang=ja&tlang=en';
let sequence = 0;
let url;
let includeEnglish;

function captured(enabled) {
  return createEngineFeatures({ internalUids: ['fixture'], flags: { languageRouting: enabled } })
    .forJob('fixture');
}

function execute(features, target = url) {
  // Rehydrate a persisted JSON snapshot under an opposing current rollout.
  const current = createEngineFeatures({ rolloutPercent: 100, flags: {
    languageRouting: features.versions.languageRouting === 'legacy',
  } });
  return jobContext.run({ features: current.forExecution(JSON.parse(JSON.stringify(features))),
    deadline: Date.now() + 10000, locale: 'en-US', homeCity: 'Boston' }, () => extractPublicPost(target));
}

beforeEach(() => {
  jest.clearAllMocks();
  // A fresh content identity starts each test with an empty real memory cache.
  url = `https://www.youtube.com/watch?v=languageFixture${++sequence}`;
  includeEnglish = true;
  lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  axios.get.mockImplementation(async target => ({ status: 200, headers: {},
    data: `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${target === nativeTrack ? nativeText : englishText}\n` }));
  spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = jest.fn();
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ title: '京都の店', description: 'Dinner @moonlight',
        webpage_url: url, language: 'ja', automatic_captions: {
          'ja-orig': [{ ext: 'vtt', url: nativeTrack, name: 'Japanese (Original)' }],
          ...(includeEnglish ? { en: [{ ext: 'vtt', url: englishTrack }] } : {}),
        } })));
      proc.emit('close', 0);
    });
    return proc;
  });
});

test('partial subtitle failure preserves usable caption but is not cached as a complete read', async () => {
  const features = captured(true);
  axios.get.mockRejectedValue({ response: { status: 403 } });
  const result = await execute(features);
  expect(result.description).toBe('Dinner @moonlight');
  expect(result.subtitle_failures).toEqual([expect.objectContaining({code:'access_blocked',language:'ja-orig'})]);
  const key = jobContext.run({features}, () => extractionKey(url));
  expect(await getCached(key)).toBeNull();
});

test.each([false, true])('native and English source-cache variants stay isolated when native is fetched first: %s', async nativeFirst => {
  const native = captured(true), english = captured(false);
  const nativeKey = jobContext.run({ features: native }, () => extractionKey(url));
  const englishKey = jobContext.run({ features: english }, () => extractionKey(url));
  expect(nativeKey).not.toBe(englishKey);
  expect(await getCached(nativeKey)).toBeNull();
  expect(await getCached(englishKey)).toBeNull();
  const first = await execute(nativeFirst ? native : english);
  const second = await execute(nativeFirst ? english : native);
  const nativeResult = nativeFirst ? first : second;
  const englishResult = nativeFirst ? second : first;
  expect(nativeResult).toMatchObject({ description: 'Dinner @moonlight', subtitles: `${nativeText} ${englishText}` });
  expect(nativeResult.subtitle_tracks).toEqual([
    { language: 'ja-orig', text: nativeText, provenance: { original: true, automatic: true, manual: false, translation: false },
      segments:[{startMs:1000,endMs:3000,text:nativeText,timing:'native'}] },
    { language: 'en', text: englishText, provenance: { original: false, automatic: true, manual: false, translation: true },
      segments:[{startMs:1000,endMs:3000,text:englishText,timing:'native'}] },
  ]);
  expect(englishResult.subtitles).toBe(englishText);
  expect(englishResult.subtitle_tracks).toEqual([nativeResult.subtitle_tracks[1]]);
  expect(await getCached(nativeKey)).toEqual(nativeResult);
  expect(await getCached(englishKey)).toEqual(englishResult);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(axios.get.mock.calls.map(([target]) => target)).toEqual(nativeFirst
    ? [nativeTrack, englishTrack, englishTrack] : [englishTrack, nativeTrack, englishTrack]);

  // Canonical watch URL, short URL, and tracking variants share each language's cache.
  const shortUrl = `https://youtu.be/languageFixture${sequence}?utm_source=share`;
  expect(await execute(native, shortUrl)).toEqual(nativeResult);
  expect(await execute(english, url + '&utm_source=share')).toEqual(englishResult);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(axios.get).toHaveBeenCalledTimes(3);
});

test('overlapping extraction coalesces within a language but cannot reuse the other language in flight', async () => {
  const native = captured(true), english = captured(false);
  const results = await Promise.all([
    execute(native), execute(english), execute(native, url + '&utm_source=share'), execute(english),
  ]);
  expect(results.map(result => result.subtitles)).toEqual([
    `${nativeText} ${englishText}`, englishText, `${nativeText} ${englishText}`, englishText,
  ]);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(axios.get).toHaveBeenCalledTimes(3);
});

test('unrecorded legacy execution still requests only English despite an enabled live rollout', async () => {
  const live = createEngineFeatures({ rolloutPercent: 100, flags: { languageRouting: true } });
  const result = await jobContext.run({ features: live.forExecution(undefined) }, () => extractPublicPost(url));
  expect(result.subtitles).toBe(englishText);
  expect(axios.get.mock.calls.map(([target]) => target)).toEqual([englishTrack]);
});

test('an English-only cached result with no captions cannot hide native-only evidence from the enabled variant', async () => {
  includeEnglish = false;
  const english = await execute(captured(false));
  expect(english).toMatchObject({ description: 'Dinner @moonlight', subtitles: null, subtitle_tracks: [] });
  expect(axios.get).not.toHaveBeenCalled();
  const native = await execute(captured(true));
  expect(native.subtitles).toBe(nativeText);
  expect(native.subtitle_tracks).toEqual([expect.objectContaining({ language: 'ja-orig', text: nativeText })]);
  expect(axios.get.mock.calls.map(([target]) => target)).toEqual([nativeTrack]);
  expect(spawn).toHaveBeenCalledTimes(2);
});

test.each([
  'https://youtube.com.evil.example/watch?v=languageFixture',
  'https://evil.example/?url=https://youtube.com/watch?v=languageFixture',
  'https://music.youtube.com/watch?v=languageFixture',
  'https://www.youtube.com/redirect?q=https://evil.example',
])('native extraction rejects unsupported routing host/path without a provider call: %s', async target => {
  await expect(execute(captured(true), target)).rejects.toMatchObject({ code: 'source_unavailable', stage: 'input' });
  expect(spawn).not.toHaveBeenCalled();
  expect(axios.get).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});
