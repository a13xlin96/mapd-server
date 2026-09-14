const { spawn } = require('child_process');
const axios = require('axios');
const { fetchPublic } = require('./publicFetch');
const { current } = require('./jobContext');
const { isAllowedExtractUrl } = require('./urlValidation');
const { classifyContentProvider } = require('./contentProvider');
const { EngineError, asEngineError, failureOf } = require('./engineError');

const TIMEOUT_MS = 30000;
const SUBTITLE_TIMEOUT_MS = 15000;
const MAX_SUBTITLE_BYTES = 256 * 1024;
const MAX_SUBTITLE_CHARS = 16000;

function isAllowedYtDlpUrl(url) {
  if (!isAllowedExtractUrl(url)) return false;
  if (classifyContentProvider(url)) return true;
  // Preserve the pre-existing Maps contract while requiring exact social
  // hosts even when this module is invoked without the routing layer.
  const host = new URL(url).hostname;
  return host === 'google.com' || host.endsWith('.google.com') || host === 'goo.gl' || host === 'maps.app.goo.gl';
}

function deadlineFor(options = {}, budget = TIMEOUT_MS + SUBTITLE_TIMEOUT_MS) {
  return Math.min(Date.now() + budget,
    Number.isFinite(options.deadline) ? options.deadline : Infinity,
    Number.isFinite(current()?.deadline) ? current().deadline : Infinity);
}

// Strip anything that could contain secrets (signed URL query strings, auth
// headers, cookies) before returning stderr to clients or writing to Firestore.
function scrubStderr(text) {
  if (!text) return '';
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]')
    .replace(/(authorization|cookie|set-cookie|x-api-key):\s*\S+/gi, '$1: [redacted]')
    .slice(0, 500);
}

function runYtDlp(url, options = {}) {
  const deadline = deadlineFor(options);
  return new Promise((resolve, reject) => {
    // Defense-in-depth: every caller (index.js /extract, enrich.js's
    // yt-dlp fallbacks) should already validate with isAllowedExtractUrl,
    // but re-check here so this is the single point that can never spawn
    // yt-dlp on an option-injection payload or a non-allowlisted/SSRF URL.
    if (!isAllowedYtDlpUrl(url)) {
      return reject({ message: 'unsupported or invalid url', code: 'INVALID_URL' });
    }
    if (deadline <= Date.now()) return reject({ message: 'Extraction timed out', code: 'TIMEOUT' });
    let proc;
    try {
      proc = spawn('yt-dlp', ['--ignore-config', '--dump-single-json', '--no-download', '--no-playlist',
        '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', '--', url]);
    } catch { return reject({ message: 'Extraction failed to start', code: 'UNKNOWN' }); }
    let stopped = false;
    const fail = error => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      proc.kill('SIGKILL');
      reject(error);
    };

    let stdout = '';
    let stderr = '';

    const chunks = [];
    let bytes = 0;
    proc.stdout.on('data', (d) => {
      if (stopped) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return fail({ message: 'Extraction output too large', code: 'INPUT_TOO_LARGE' });
      chunks.push(chunk);
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-16384); });

    const timeout = setTimeout(() => {
      fail({ message: 'Extraction timed out', code: 'TIMEOUT' });
    }, Math.min(TIMEOUT_MS, deadline - Date.now()));

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (stopped) return;
      stopped = true;
      stdout = Buffer.concat(chunks).toString('utf8');

      if (code !== 0) {
        // Scrub stderr before it reaches either logs or returned errors.
        console.error('yt-dlp failed:', scrubStderr(stderr));
        const lower = stderr.toLowerCase();
        if (/429|rate.?limit|too many requests/.test(lower)) return reject({message:'Source rate limit',status:429,code:'RATE_LIMITED'});
        if (lower.includes('unsupported url')) {
          return reject({ message: 'This URL type is not supported yet.', code: 'UNSUPPORTED_URL_TYPE' });
        }
        if (lower.includes('ip address is blocked')) {
          return reject({ message: 'Access blocked by the platform.', code: 'IP_BLOCKED' });
        }
        if (lower.includes('private')) {
          return reject({ message: 'This video is private.', code: 'PRIVATE' });
        }
        if (
          lower.includes('login required') ||
          lower.includes('not granting access') ||
          lower.includes('empty media response') ||
          lower.includes('rate-limit') ||
          lower.includes('rate limit')
        ) {
          return reject({ message: 'Temporarily blocked by the platform.', code: 'BLOCKED' });
        }
        if (lower.includes('deleted') || lower.includes('not available')) {
          return reject({ message: 'This video is unavailable.', code: 'DELETED' });
        }
        return reject({ message: `Extraction failed: ${scrubStderr(stderr)}`, code: 'UNKNOWN' });
      }

      try {
        const json = JSON.parse(stdout);
        const firstEntry = json.entries && json.entries[0];
        const title = json.title || (firstEntry && firstEntry.title) || '';
        const description = json.description || (firstEntry && firstEntry.description) || title;
        const thumbnail = json.thumbnail
          || (json.thumbnails && json.thumbnails[0] && json.thumbnails[0].url)
          || (firstEntry && firstEntry.thumbnail)
          || (firstEntry && firstEntry.thumbnails && firstEntry.thumbnails[0] && firstEntry.thumbnails[0].url)
          || '';
        const uploader = json.uploader || json.channel || json.creator
          || (firstEntry && (firstEntry.uploader || firstEntry.channel)) || '';
        const location = json.location || (firstEntry && firstEntry.location) || null;

        const hashtags = ((description || '').match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || [])
          .map((t) => t.slice(1).toLowerCase());

        const entries = json.entries || [];
        const slideThumbnails = entries
          .map((e) => e.thumbnail || (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || null)
          .filter(Boolean)
          .slice(0, 20);

        const result = {
          title, description, thumbnail_url: thumbnail, uploader,
          hashtags: [...new Set(hashtags)],
          // Never promote an unvalidated metadata URL into a later fetch/cache key.
          webpage_url: isAllowedYtDlpUrl(json.webpage_url) ? json.webpage_url : url,
          location, is_carousel: entries.length > 1, slide_count: entries.length,
          slide_thumbnails: slideThumbnails,
        };
        extractSubtitleTracks(json, { deadline, englishOnly: options.multilingual === false, provider: classifyContentProvider(url) || 'source' }).then(({ tracks, failures }) => resolve({
          ...result, subtitles: tracks.map(track => track.text).join(' ') || null,
          subtitle_tracks: tracks, subtitle_failures: failures,
        })).catch(() => resolve({ ...result, subtitles: null, subtitle_tracks: [],
          subtitle_failures: [failureOf(new EngineError('dependency_error', { stage: 'subtitles', provider: classifyContentProvider(url) || 'source' }))] }));
      } catch {
        reject({ message: 'Failed to parse extraction output', code: 'UNKNOWN' });
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      if (stopped) return;
      stopped = true;
      reject({ message: 'Extraction failed to start', code: 'UNKNOWN' });
    });
  });
}

// Language comes only from provider track/audio metadata, never user locale.
function languageKey(value) {
  return String(value || '').replace(/-orig$/i, '').toLowerCase().replace(/_/g, '-');
}

function selectSubtitleTracks(metadata, { englishOnly = false } = {}) {
  const candidates = [];
  const source = languageKey(metadata?.language);
  for (const [field, automatic] of [['subtitles', false], ['automatic_captions', true]]) {
    const available = metadata?.[field];
    if (!available || typeof available !== 'object') continue;
    for (const [language, formats] of Object.entries(available)) {
      if (englishOnly && !/^(en(?:-|$)|eng$)/.test(languageKey(language))) continue;
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(language) || /live_chat/i.test(language) || !Array.isArray(formats)) continue;
      // One format per language; no regex language downloads or fallback fan-out.
      const format = ['vtt', 'srt', 'json3'].flatMap(ext => formats.filter(f => f?.ext === ext && typeof f.url === 'string'))
        .find(f => {
          try { const u = new URL(f.url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443'); }
          catch { return false; }
        });
      if (!format) continue;
      const target = new URL(format.url);
      const translated = Boolean(target.searchParams.get('tlang')) || /translated|translation| from /i.test(format.name || '');
      const original = !translated && (/-orig$/i.test(language) || /\(original\)/i.test(format.name || '') || Boolean(source && languageKey(language) === source));
      candidates.push({ language, url: format.url, format: format.ext,
        provenance: { original, manual: !automatic, automatic, translation: translated } });
    }
  }
  // An explicit original track also identifies a manual track in the same
  // language when top-level audio language is missing.
  const originalLanguages = new Set(candidates.filter(track => track.provenance.original).map(track => languageKey(track.language)));
  for (const candidate of candidates) {
    if (!candidate.provenance.translation && originalLanguages.has(languageKey(candidate.language))) candidate.provenance.original = true;
  }
  const rank = track => (track.provenance.original ? 0 : track.provenance.translation ? 4 : 2) + (track.provenance.automatic ? 1 : 0);
  candidates.sort((a, b) => rank(a) - rank(b));
  const first = candidates[0];
  if (!first) return [];
  const others = candidates.filter(track => languageKey(track.language) !== languageKey(first.language) && track.url !== first.url);
  // An available English translation is useful supporting evidence, but its
  // absence never excludes native tracks. Do not manufacture translation URLs.
  others.sort((a, b) => Number(b.provenance.translation) - Number(a.provenance.translation)
    || Number(/^en(?:-|$)|^eng$/.test(languageKey(b.language))) - Number(/^en(?:-|$)|^eng$/.test(languageKey(a.language)))
    || rank(a) - rank(b));
  return [first, ...others.slice(0, 1)];
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

function parseSubtitleText(body, format) {
  let lines = [];
  if (format === 'json3') {
    const json = JSON.parse(body);
    if (!Array.isArray(json.events)) return null;
    lines = json.events.filter(e => Array.isArray(e.segs))
      .map(e => e.segs.map(seg => typeof seg.utf8 === 'string' ? seg.utf8 : '').join(''));
  } else {
    // Only cue payload is evidence. Ignore IDs, timestamps, STYLE and NOTE
    // blocks (including numeric and mm:ss timestamps) rather than indexing them.
    for (const block of body.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
      const parts = block.split('\n');
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(parts[0])) continue;
      const cue = parts.findIndex(line => /^\s*(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}/.test(line));
      if (cue !== -1) lines.push(...parts.slice(cue + 1));
    }
  }
  lines = lines.map(line => decodeEntities(line.replace(/<[^>]*>/g, '')).normalize('NFC').trim()).filter(Boolean);
  const text = lines.filter((line, i) => i === 0 || line !== lines[i - 1]).join(' ');
  return text && text.length <= MAX_SUBTITLE_CHARS ? text : null;
}

async function extractSubtitleTracks(metadata, options = {}) {
  const deadline = deadlineFor(options, SUBTITLE_TIMEOUT_MS);
  const tracks = [], failures = [];
  const context = { stage: 'subtitles', provider: options.provider || 'source' };
  let chars = 0;
  for (const selected of selectSubtitleTracks(metadata, options)) {
    const remaining = deadline - Date.now();
    if (chars >= MAX_SUBTITLE_CHARS) break;
    if (remaining <= 0) { failures.push(failureOf(new EngineError('dependency_timeout', context))); break; }
    const controller = new AbortController();
    let timer;
    try {
      // fetchPublic validates/pins DNS and checks every redirect. Its axios
      // defaults are intentionally tightened here for subtitle bodies.
      const client = { get: (url, config) => {
        if (controller.signal.aborted || Date.now() >= deadline) throw new EngineError('dependency_timeout', context);
        return axios.get(url, { ...config, signal: controller.signal, responseType: 'text',
          transformResponse: [data => data], maxContentLength: MAX_SUBTITLE_BYTES,
          maxBodyLength: MAX_SUBTITLE_BYTES, timeout: Math.min(config.timeout, deadline - Date.now()) });
      } };
      const response = await Promise.race([
        fetchPublic(selected.url, client),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new EngineError('dependency_timeout', context));
        }, remaining); }),
      ]);
      if (controller.signal.aborted || Date.now() >= deadline) throw new EngineError('dependency_timeout', context);
      const body = response.data;
      if (response.status !== 200) throw asEngineError({ status: response.status }, context);
      if (typeof body !== 'string') throw new EngineError('invalid_response', context);
      if (Buffer.byteLength(body, 'utf8') > MAX_SUBTITLE_BYTES) throw new EngineError('input_too_large', context);
      const text = parseSubtitleText(body, selected.format);
      if (!text) throw new EngineError('invalid_response', context);
      if (tracks.some(track => track.text === text)) continue;
      // Keep the legacy total character budget; never split a surrogate pair.
      const budget = MAX_SUBTITLE_CHARS - chars - (tracks.length ? 1 : 0);
      let bounded = text.slice(0, Math.max(0, budget));
      if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
      if (!bounded) break;
      tracks.push({ language: selected.language, provenance: selected.provenance, text: bounded,
        ...(bounded.length < text.length ? { truncated: true } : {}) });
      chars += bounded.length + (tracks.length > 1 ? 1 : 0);
    } catch (error) {
      // A missing/blocked/oversized optional track cannot erase caption or
      // previously read subtitle evidence. No alternate-format retries.
      const failure = failureOf(asEngineError(error, context));
      failures.push({ ...failure, language: selected.language });
      if (['rate_limited', 'access_blocked', 'attempt_stopped', 'dependency_timeout'].includes(failure.code)) break;
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { tracks, failures };
}

// Retain the string API for older callers. Without metadata, perform the same
// single bounded metadata extraction used by runYtDlp, not an all-language fetch.
async function extractSubtitles(url, metadata, options = {}) {
  if (!isAllowedYtDlpUrl(url)) return null;
  try {
    if (!metadata) return (await runYtDlp(url, options)).subtitles;
    const { tracks } = await extractSubtitleTracks(metadata, options);
    return tracks.map(track => track.text).join(' ') || null;
  } catch { return null; }
}

module.exports = { runYtDlp, extractSubtitles };
