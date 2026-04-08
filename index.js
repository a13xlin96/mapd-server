const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(cors());
app.use(express.json());

const TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const anthropic = new Anthropic();

// --- In-memory URL cache for extraction results ---
const extractionCache = new Map();

function getCached(url) {
  const entry = extractionCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    extractionCache.delete(url);
    return null;
  }
  return entry.data;
}

function setCache(url, data) {
  // Cap cache size to prevent memory leaks (LRU-style: delete oldest if over 5000)
  if (extractionCache.size > 5000) {
    const oldest = extractionCache.keys().next().value;
    extractionCache.delete(oldest);
  }
  extractionCache.set(url, { data, timestamp: Date.now() });
}

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

  // Check cache first
  const cached = getCached(url);
  if (cached) {
    console.log('Cache hit:', url.slice(0, 60));
    return res.json(cached);
  }

  console.log('Extracting:', url);

  try {
    const data = await runYtDlp(url);
    console.log('Extracted:', data.title?.slice(0, 60));
    setCache(url, data);
    res.json(data);
  } catch (error) {
    console.error('Extraction failed:', error.message);
    res.status(422).json({ error: error.message, code: error.code || 'UNKNOWN' });
  }
});

// AI Step 2b: Extract place name from caption text when regex fails
app.post('/ai/extract-place', async (req, res) => {
  const { title, description } = req.body;

  if (!title && !description) {
    return res.status(400).json({ error: 'title or description required' });
  }

  // Cache by caption content
  const cacheKey = `ai:extract:${(title || '').slice(0, 50)}:${(description || '').slice(0, 50)}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Truncate to keep token usage low
    const caption = `${title || ''}\n${(description || '').slice(0, 800)}`.trim();

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `You are extracting the specific place name from a social media post about a real-world location (restaurant, bar, cafe, shop, attraction, hotel, etc.).

Look for:
- Named businesses ("at Ichiran Ramen", "the Sandwich Board", "visited Bavel")
- Places after prepositions ("at", "in", "visited", "tried", "went to")
- Places before locations ("Cafe Luna in Brooklyn", "Weng Yao Chicken, Jiaoxi")

Caption:
${caption}

Return ONLY valid JSON: {"name": "place name", "city": "city or neighborhood", "country": "country"}
If the post does NOT mention any specific named place (just a generic "best pizza" with no name), return: null`,
      }],
    });

    let text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

    // Strip markdown code fences if present (```json ... ```)
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    if (!text || text === 'null') {
      return res.json({ place: null });
    }

    const parsed = JSON.parse(text);
    if (parsed?.name) {
      const result = { place: parsed };
      setCache(cacheKey, result);
      return res.json(result);
    }
    const result = { place: null };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('AI extract-place failed:', error.message);
    res.json({ place: null });
  }
});

// AI Step 4b: Verify if a Google Places result matches what the caption describes
app.post('/ai/verify-place', async (req, res) => {
  const { title, description, placeName, placeAddress, placeTypes } = req.body;

  if (!description && !title) {
    return res.status(400).json({ error: 'title or description required' });
  }

  try {
    const caption = `${title || ''}\n${(description || '').slice(0, 600)}`.trim();

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `A social media post mentions a place. We searched Google Places and got a result. Does the result match what the post is actually about?\n\nCaption:\n${caption}\n\nGoogle Places result:\n- Name: ${placeName}\n- Address: ${placeAddress}\n- Types: ${(placeTypes || []).join(', ')}\n\nReturn ONLY valid JSON: {"match": true/false, "betterQuery": "refined search query if not a match, or null"}`,
      }],
    });

    let text2 = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    text2 = text2.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    if (!text2) {
      return res.json({ match: true, betterQuery: null });
    }

    const parsed = JSON.parse(text2);
    res.json({
      match: parsed?.match ?? true,
      betterQuery: parsed?.betterQuery || null,
    });
  } catch (error) {
    console.error('AI verify-place failed:', error.message);
    res.json({ match: true, betterQuery: null });
  }
});

// AI Vision: Extract place names from carousel slide images
app.post('/ai/vision-extract', async (req, res) => {
  const { imageUrls } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'imageUrls array required' });
  }

  // Cache by first image URL
  const cacheKey = `ai:vision:${imageUrls[0]?.slice(0, 60)}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Send up to 5 slide images to Claude vision
    const imageContent = imageUrls.slice(0, 5).map((url) => ({
      type: 'image',
      source: { type: 'url', url },
    }));

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          {
            type: 'text',
            text: 'These are slides from a social media carousel post about places to visit. Read any place names, restaurant names, bar names, cafe names, or location names that appear as text overlays in the images. Return ONLY valid JSON: {"places": ["Place Name 1", "Place Name 2"]} or {"places": []} if no place names are visible.',
          },
        ],
      }],
    });

    let text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    if (!text || text === 'null') {
      const result = { places: [] };
      setCache(cacheKey, result);
      return res.json(result);
    }

    const parsed = JSON.parse(text);
    const result = { places: parsed?.places || [] };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('AI vision-extract failed:', error.message);
    res.json({ places: [] });
  }
});

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    // --dump-single-json outputs one JSON object for the whole post (including
    // playlist-level caption for carousels) instead of one object per slide.
    const proc = spawn('yt-dlp', ['--dump-single-json', '--no-download', '--impersonate', 'chrome', '-v', url]);

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
          return reject({ message: `This video is unavailable. Debug: ${stderr.slice(-300)}`, code: 'DELETED' });
        }
        return reject({ message: `Extraction failed: ${stderr.slice(-300)}`, code: 'UNKNOWN' });
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

        // Collect slide thumbnails for carousels (for vision-based place extraction)
        const entries = json.entries || [];
        const slideThumbnails = entries
          .map((e) => e.thumbnail || e.thumbnails?.[0]?.url || null)
          .filter(Boolean)
          .slice(0, 10); // Cap at 10 slides

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
