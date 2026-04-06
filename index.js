const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const TIMEOUT_MS = 30000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'mapd-link-extractor' });
});

// Extract metadata from a social media link
app.post('/extract', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log('Extracting:', url);

  try {
    const data = await runYtDlp(url);
    console.log('Extracted:', data.title?.slice(0, 60));
    res.json(data);
  } catch (error) {
    console.error('Extraction failed:', error.message);
    res.status(422).json({ error: error.message, code: error.code || 'UNKNOWN' });
  }
});

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    // --dump-single-json outputs one JSON object for the whole post (including
    // playlist-level caption for carousels) instead of one object per slide.
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
        const lower = stderr.toLowerCase();
        if (lower.includes('private') || lower.includes('login required')) {
          return reject({ message: 'This video is private.', code: 'PRIVATE' });
        }
        if (lower.includes('deleted') || lower.includes('not available')) {
          return reject({ message: 'This video is unavailable.', code: 'DELETED' });
        }
        return reject({ message: `Extraction failed: ${stderr.slice(0, 200)}`, code: 'UNKNOWN' });
      }

      try {
        const json = JSON.parse(stdout);

        // For carousels/playlists, the caption lives at the top level.
        // Individual entries only have generic titles like "Video 2".
        // Prefer top-level fields, fall back to first entry for thumbnails.
        const firstEntry = json.entries?.[0];
        const title = json.title || firstEntry?.title || '';
        const description = json.description || firstEntry?.description || title;
        const thumbnail = json.thumbnail
          || json.thumbnails?.[0]?.url
          || firstEntry?.thumbnail
          || firstEntry?.thumbnails?.[0]?.url
          || '';
        const uploader = json.uploader || json.channel || json.creator
          || firstEntry?.uploader || firstEntry?.channel || '';
        const location = json.location || firstEntry?.location || null;

        const hashtags = (description.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || [])
          .map((t) => t.slice(1).toLowerCase());

        resolve({
          title,
          description,
          thumbnail_url: thumbnail,
          uploader,
          hashtags: [...new Set(hashtags)],
          webpage_url: json.webpage_url || url,
          location,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mapd link extractor running on port ${PORT}`);
});
