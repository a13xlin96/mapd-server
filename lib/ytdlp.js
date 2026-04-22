const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 30000;

// Strip anything that could contain secrets (signed URL query strings, auth
// headers, cookies) before returning stderr to clients or writing to Firestore.
function scrubStderr(text) {
  if (!text) return '';
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]')
    .replace(/(authorization|cookie|set-cookie|x-api-key):\s*\S+/gi, '$1: [redacted]')
    .slice(0, 500);
}

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-single-json', '--no-download', url]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject({ message: 'Extraction timed out', code: 'TIMEOUT' });
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        // Log full stderr to server logs (not the response) so signed URLs and
        // auth tokens don't leak into the client or Firestore enrichmentLogs.
        console.error('yt-dlp failed for', url, '\n', stderr);
        const lower = stderr.toLowerCase();
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
          .slice(0, 10);

        extractSubtitles(json.webpage_url || url).then((subtitles) => {
          resolve({
            title,
            description,
            thumbnail_url: thumbnail,
            uploader,
            hashtags: [...new Set(hashtags)],
            webpage_url: json.webpage_url || url,
            location,
            is_carousel: entries.length > 1,
            slide_count: entries.length,
            slide_thumbnails: slideThumbnails,
            subtitles,
          });
        }).catch(() => {
          resolve({
            title,
            description,
            thumbnail_url: thumbnail,
            uploader,
            hashtags: [...new Set(hashtags)],
            webpage_url: json.webpage_url || url,
            location,
            is_carousel: entries.length > 1,
            slide_count: entries.length,
            slide_thumbnails: slideThumbnails,
            subtitles: null,
          });
        });
      } catch {
        reject({ message: 'Failed to parse extraction output', code: 'UNKNOWN' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject({ message: err.message, code: 'UNKNOWN' });
    });
  });
}

function extractSubtitles(url) {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-subs-'));
    const outTemplate = path.join(tmpDir, 'subs');

    const proc = spawn('yt-dlp', [
      '--write-auto-subs',
      '--write-subs',
      '--sub-lang', 'en.*,eng.*',
      '--sub-format', 'vtt/srt/best',
      '--skip-download',
      '-o', outTemplate,
      url,
    ]);

    const timeout = setTimeout(() => {
      proc.kill();
      cleanup(tmpDir);
      resolve(null);
    }, 15000);

    proc.on('close', () => {
      clearTimeout(timeout);

      try {
        const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.vtt') || f.endsWith('.srt'));
        if (files.length === 0) {
          cleanup(tmpDir);
          return resolve(null);
        }

        const subText = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
        cleanup(tmpDir);

        const lines = subText.split('\n')
          .filter((line) => {
            if (line.startsWith('WEBVTT')) return false;
            if (line.startsWith('Kind:') || line.startsWith('Language:')) return false;
            if (/^\d{2}:\d{2}/.test(line)) return false;
            if (/^\d+$/.test(line.trim())) return false;
            if (line.trim() === '') return false;
            return true;
          })
          .map((line) => line.replace(/<[^>]+>/g, '').trim())
          .filter(Boolean);

        const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
        const transcript = deduped.join(' ').slice(0, 3000);

        resolve(transcript || null);
      } catch {
        cleanup(tmpDir);
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      cleanup(tmpDir);
      resolve(null);
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { runYtDlp, extractSubtitles };
