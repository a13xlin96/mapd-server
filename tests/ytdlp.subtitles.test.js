const { EventEmitter } = require('events');
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));
jest.mock('../lib/providerRuntime', () => ({ withProvider: (_provider, work) => work() }));
const { spawn } = require('child_process');
const axios = require('axios');
const { lookup } = require('dns').promises;
const { runYtDlp, extractSubtitles } = require('../lib/ytdlp');
const jobContext = require('../lib/jobContext');
const url = 'https://www.youtube.com/watch?v=fixture123';
const track = (language, extra = {}) => ({
  ext: 'vtt', url: `https://www.youtube.com/api/timedtext?lang=${language}`, ...extra,
});
const vtt = text => `WEBVTT\nKind: captions\nLanguage: xx\n\ncue-id\n00:01.000 --> 00:03.000 align:start\n${text}\n`;

function metadataProcess(metadata, chunkSize) {
  spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = jest.fn();
    setImmediate(() => {
      const bytes = Buffer.from(JSON.stringify(metadata));
      for (let i = 0; i < bytes.length; i += chunkSize || bytes.length) proc.stdout.emit('data', bytes.subarray(i, i + (chunkSize || bytes.length)));
      proc.emit('close', 0);
    });
    return proc;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  axios.get.mockResolvedValue({ status: 200, headers: {}, data: vtt('Café José') });
});
afterEach(() => jest.useRealTimers());

test('one metadata subprocess, original Japanese then available English translation; never downloads all languages', async () => {
  metadataProcess({ title: '京都', description: 'Dinner @restaurant_京都', language: 'ja', automatic_captions: {
    fr: [track('fr', { url: 'https://www.youtube.com/api/timedtext?lang=ja&tlang=fr' })],
    'ja-orig': [track('ja', { name: 'Japanese (Original)' })],
    ja: [track('ja')],
    en: [track('en', { url: 'https://www.youtube.com/api/timedtext?lang=ja&tlang=en' })],
    ko: [track('ko')],
  } }, 1);
  axios.get.mockImplementation(async target => ({ status: 200, headers: {},
    data: vtt(target.includes('tlang=en') ? 'Kyoto Café' : '京都の喫茶店 珈琲 ☕') }));
  const result = await runYtDlp(url);
  expect(spawn).toHaveBeenCalledTimes(1);
  const [command, args] = spawn.mock.calls[0];
  expect(command).toBe('yt-dlp');
  expect(args).toEqual(['--ignore-config', '--dump-single-json', '--no-download', '--no-playlist',
    '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', '--', url]);
  expect(result.description).toBe('Dinner @restaurant_京都');
  expect(result.title).toBe('京都'); // UTF-8 can span subprocess chunks.
  expect(result.subtitles).toBe('京都の喫茶店 珈琲 ☕ Kyoto Café');
  expect(result.subtitle_tracks).toEqual([
    { language: 'ja-orig', text: '京都の喫茶店 珈琲 ☕', provenance: { original: true, automatic: true, manual: false, translation: false } },
    { language: 'en', text: 'Kyoto Café', provenance: { original: false, automatic: true, manual: false, translation: true } },
  ]);
  expect(axios.get).toHaveBeenCalledTimes(2);
  expect(axios.get.mock.calls.map(call => call[0])).toEqual([
    'https://www.youtube.com/api/timedtext?lang=ja', 'https://www.youtube.com/api/timedtext?lang=ja&tlang=en',
  ]);
});

test.each([
  ['zh-Hans', '上海 小笼包'], ['ja', '喫茶 月光'], ['ko', '서울 한식당'],
  ['es', 'Cafe\u0301 José @casa_oficial'], ['en', 'Dinner at Café José'],
])('manual %s caption works without any translation or other language', async (language, text) => {
  metadataProcess({ subtitles: { [language]: [track(language)] } });
  axios.get.mockResolvedValue({ status: 200, headers: {}, data: vtt(text) });
  const result = await runYtDlp(url);
  expect(result.subtitles).toBe(text.normalize('NFC'));
  expect(result.subtitle_tracks[0].provenance).toEqual({ manual: true, automatic: false, original: false, translation: false });
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('prefers manual source captions over automatic duplicate and ignores unsupported formats', async () => {
  metadataProcess({ language: 'es', subtitles: { es: [track('es', { ext: 'ttml' }), track('es')] },
    automatic_captions: { 'es-orig': [track('es')], live_chat: [track('chat', { ext: 'json3' })] } });
  const result = await runYtDlp(url);
  expect(result.subtitle_tracks).toHaveLength(1);
  expect(result.subtitle_tracks[0].provenance).toEqual({ manual: true, automatic: false, original: true, translation: false });
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('an original marker identifies manual source language without locale or geography inference', async () => {
  metadataProcess({ description: 'Café José — Centro / Norte @casa', subtitles: { es: [track('es')] },
    automatic_captions: { 'es-orig': [track('es')] } });
  const result = await jobContext.run({ locale: 'en-US', homeCountry: 'US', homeCity: 'Boston' }, () => runYtDlp(url));
  expect(result.subtitle_tracks).toEqual([{ language: 'es', text: 'Café José',
    provenance: { original: true, manual: true, automatic: false, translation: false } }]);
  expect(result.description).toBe('Café José — Centro / Norte @casa');
  expect(result.location).toBeNull();
});

test('parses SRT and JSON3, strips timing/styles and preserves native names and entities', async () => {
  metadataProcess({ language: 'ko', subtitles: {
    ko: [track('ko', { ext: 'srt' })], en: [track('en', { ext: 'json3' })],
  } });
  axios.get.mockResolvedValueOnce({ status: 200, data: '1\r\n00:00:01,000 --> 00:00:02,000\r\n<b>서울</b> &amp; Café\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n서울 &amp; Café', headers: {} })
    .mockResolvedValueOnce({ status: 200, data: JSON.stringify({ events: [{ tStartMs: 1, segs: [{ utf8: 'Seoul ' }, { utf8: '&#x1f35c;' }] }] }), headers: {} });
  expect((await runYtDlp(url)).subtitles).toBe('서울 & Café Seoul 🍜');
});

test('ignores VTT NOTE, STYLE, cue identifiers and timestamps', async () => {
  metadataProcess({ subtitles: { en: [track('en')] } });
  axios.get.mockResolvedValue({ status: 200, headers: {}, data: 'WEBVTT\n\nNOTE not evidence\n00:01.000 --> 00:02.000\nwrong\n\nSTYLE\n::cue { color: red; }\n\nvenue-id\n00:00:01.000 --> 00:00:03.000\n<c>Café</c> &#233;\n\n' });
  expect((await runYtDlp(url)).subtitles).toBe('Café é');
});

test.each(['absent', '404', 'malformed', 'bytes', 'characters'])('%s subtitle leaves description evidence intact', async failure => {
  metadataProcess({ description: 'Dinner at 小店 @casa', subtitles: failure === 'absent' ? {} : { en: [track('en')] } });
  if (failure === '404') axios.get.mockRejectedValue({ response: { status: 404 } });
  if (failure === 'malformed') axios.get.mockResolvedValue({ status: 200, data: '<html>Access denied</html>' });
  if (failure === 'bytes') axios.get.mockResolvedValue({ status: 200, data: 'x'.repeat(262145) });
  if (failure === 'characters') axios.get.mockResolvedValue({ status: 200, data: vtt('字'.repeat(16001)) });
  const result = await runYtDlp(url);
  expect(result.description).toBe('Dinner at 小店 @casa');
  expect(result.subtitles).toBeNull();
  expect(result.subtitle_tracks).toEqual([]);
  expect(axios.get).toHaveBeenCalledTimes(failure === 'absent' ? 0 : 1);
});

test.each([true, false])('one failed/oversized track cannot erase another good track (failure first: %s)', async failureFirst => {
  metadataProcess({ language: 'ja', subtitles: { ja: [track('ja')], en: [track('en')] } });
  axios.get.mockImplementation(async target => ({ status: 200, headers: {},
    data: vtt(target.endsWith(failureFirst ? 'ja' : 'en') ? 'x'.repeat(16001) : 'Café 京都') }));
  const result = await runYtDlp(url);
  expect(result.subtitles).toBe('Café 京都');
  expect(result.subtitle_tracks).toHaveLength(1);
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('enforces per-request bytes, public DNS pinning, no proxy/redirect bypass, and aggregate characters', async () => {
  metadataProcess({ language: 'ja', subtitles: { ja: [track('ja')], en: [track('en')] } });
  axios.get.mockImplementation(async (target, options) => {
    expect(options).toMatchObject({ maxContentLength: 262144, maxBodyLength: 262144, maxRedirects: 0, proxy: false, responseType: 'text' });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(8000);
    const callback = jest.fn(); options.httpsAgent.options.lookup('www.youtube.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.215.14', 4);
    return { status: 200, headers: {}, data: vtt(target.endsWith('ja') ? '字'.repeat(10000) : '🍜'.repeat(4000)) };
  });
  const result = await runYtDlp(url);
  expect(result.subtitles.length).toBeLessThanOrEqual(16000);
  expect(result.subtitle_tracks[1].text).toBe('🍜'.repeat(2999));
  expect(result.subtitle_tracks[1].truncated).toBe(true);
});

test.each([401, 403, 429])('subtitle HTTP %s preserves earlier evidence and stops further requests', async status => {
  metadataProcess({ description: 'Good caption @casa', subtitles: { ja: [track('ja')], en: [track('en')] } });
  axios.get.mockRejectedValueOnce({ response: { status } });
  const result = await runYtDlp(url);
  expect(result.description).toBe('Good caption @casa');
  expect(result.subtitles).toBeNull();
  expect(result.subtitle_failures).toEqual([expect.objectContaining({ code: status === 429 ? 'rate_limited' : 'access_blocked', stage: 'subtitles', language: 'ja' })]);
  expect(JSON.stringify(result.subtitle_failures)).not.toContain('timedtext');
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('duplicate translated text adds no repeated evidence', async () => {
  metadataProcess({ language: 'ja', subtitles: { ja: [track('ja')], en: [track('en')] } });
  const result = await runYtDlp(url);
  expect(result.subtitles).toBe('Café José');
  expect(result.subtitle_tracks).toHaveLength(1);
});

test('metadata URLs and subtitle redirects cannot fetch private hosts', async () => {
  metadataProcess({ webpage_url: 'https://127.0.0.1/private', description: 'Café preserved', subtitles: { en: [track('en')] } });
  axios.get.mockResolvedValueOnce({ status: 302, headers: { location: 'https://127.0.0.1/internal' } });
  const result = await runYtDlp(url);
  expect(result.webpage_url).toBe(url);
  expect(result.description).toBe('Café preserved');
  expect(result.subtitles).toBeNull();
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test.each(['http://example.com/sub.vtt', 'https://u:p@example.com/sub.vtt', 'https://127.0.0.1/sub.vtt', 'https://example.com:8443/sub.vtt'])('does not request unsafe subtitle URL %s', async target => {
  metadataProcess({ subtitles: { en: [track('en', { url: target })] } });
  expect((await runYtDlp(url)).subtitles).toBeNull();
  expect(axios.get).not.toHaveBeenCalled();
});

test('legacy direct string API validates input and can use supplied metadata', async () => {
  expect(await extractSubtitles('--config-location=/tmp/evil')).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
  expect(await extractSubtitles(url, { subtitles: { es: [track('es')] } })).toBe('Café José');
});

test('legacy direct string API without metadata performs one bounded extraction', async () => {
  metadataProcess({ subtitles: { en: [track('en')] } });
  expect(await extractSubtitles(url)).toBe('Café José');
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('malformed JSON3 is optional evidence failure', async () => {
  metadataProcess({ description: 'Good caption', subtitles: { en: [track('en', { ext: 'json3' })] } });
  axios.get.mockResolvedValue({ status: 200, data: '{not JSON}' });
  expect(await runYtDlp(url)).toMatchObject({ description: 'Good caption', subtitles: null, subtitle_tracks: [] });
});

test('expired explicit and job deadlines prevent any subprocess or subtitle request', async () => {
  await expect(runYtDlp(url, { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  await jobContext.run({ deadline: Date.now() - 1 }, async () => {
    await expect(runYtDlp(url)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await extractSubtitles(url, { subtitles: { en: [track('en')] } })).toBeNull();
  });
  expect(spawn).not.toHaveBeenCalled(); expect(axios.get).not.toHaveBeenCalled();
});

test('subtitle deadline aborts the request, prevents second track, and retains caption', async () => {
  jest.useFakeTimers();
  metadataProcess({ description: 'Good caption 小店', subtitles: { ja: [track('ja')], en: [track('en')] } });
  let signal;
  axios.get.mockImplementation((_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = runYtDlp(url, { deadline: Date.now() + 100 });
  await jest.advanceTimersByTimeAsync(101);
  const result = await pending;
  expect(result.description).toBe('Good caption 小店');
  expect(result.subtitles).toBeNull();
  expect(signal.aborted).toBe(true);
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('metadata timeout kills subprocess and late close cannot start subtitle fetches', async () => {
  jest.useFakeTimers();
  let proc;
  spawn.mockImplementation(() => {
    proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = jest.fn(); return proc;
  });
  const pending = runYtDlp(url, { deadline: Date.now() + 100 }).catch(error => error);
  await jest.advanceTimersByTimeAsync(101);
  expect(await pending).toMatchObject({ code: 'TIMEOUT' });
  expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ subtitles: { en: [track('en')] } })));
  proc.emit('close', 0);
  expect(axios.get).not.toHaveBeenCalled();
});

test('oversized metadata kills subprocess, settles once, and cannot launch subtitle fetches', async () => {
  let proc;
  spawn.mockImplementation(() => {
    proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = jest.fn(); return proc;
  });
  const pending = runYtDlp(url).catch(error => error);
  proc.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
  proc.emit('close', 0);
  expect(await pending).toMatchObject({ code: 'INPUT_TOO_LARGE' });
  expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  expect(axios.get).not.toHaveBeenCalled();
});
