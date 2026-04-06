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
    const proc = spawn('yt-dlp', ['--dump-json', '--no-download', url]);

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
        // yt-dlp outputs one JSON object per media item (e.g. carousel slides).
        // Take the first valid JSON object from stdout.
        const firstLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
        if (!firstLine) {
          return reject({ message: 'No JSON output from yt-dlp', code: 'UNKNOWN' });
        }
        let json = JSON.parse(firstLine);

        // yt-dlp sometimes wraps carousels/playlists in a single object with entries[]
        // (common with TikTok slideshows). Unwrap to the first entry.
        if (json._type === 'playlist' && json.entries?.length > 0) {
          json = json.entries[0];
        }

        const description = json.description || json.title || '';
        const hashtags = (description.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || [])
          .map((t) => t.slice(1).toLowerCase());

        resolve({
          title: json.title || json.playlist_title || '',
          description,
          thumbnail_url: json.thumbnail || json.thumbnails?.[0]?.url || '',
          uploader: json.uploader || json.channel || json.creator || '',
          hashtags: [...new Set(hashtags)],
          webpage_url: json.webpage_url || url,
          location: json.location || null,
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
