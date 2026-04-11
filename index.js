const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
app.use(express.json());

const TIMEOUT_MS = 30000;
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

const anthropic = new Anthropic();

// --- Persistent Redis cache with in-memory fallback ---
let redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Redis cache connected (Upstash)');
  } else {
    console.log('Redis not configured — using in-memory cache (not persistent across restarts)');
  }
} catch (err) {
  console.warn('Redis init failed, using in-memory fallback:', err.message);
}

// In-memory fallback cache (used when Redis is unavailable)
const memoryCache = new Map();

async function getCached(key) {
  // Try Redis first
  if (redis) {
    try {
      const data = await redis.get(key);
      if (data) return data;
    } catch (err) {
      console.warn('Redis get failed, falling back to memory:', err.message);
    }
  }
  // Fallback to in-memory
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_SECONDS * 1000) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

async function setCache(key, data) {
  // Write to Redis
  if (redis) {
    try {
      await redis.set(key, data, { ex: CACHE_TTL_SECONDS });
    } catch (err) {
      console.warn('Redis set failed, using memory only:', err.message);
    }
  }
  // Always write to in-memory too (fast local reads)
  if (memoryCache.size > 5000) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { data, timestamp: Date.now() });
}

/** Strip tracking params from a URL for cache key normalization */
function normalizeUrlForCache(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const param of ['_r', '_t', '_d', '_svg', 'igsh', 'igshid', 'utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'ref', 'share_id', 'g_st', 'g_ep', 'entry', 'coh', 'skid']) {
      parsed.searchParams.delete(param);
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '') + (parsed.searchParams.toString() ? '?' + parsed.searchParams.toString() : '');
  } catch {
    return rawUrl;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'mapd-link-extractor' });
});

// Privacy Policy
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mapd — Privacy Policy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F9F8F6; color: #1C1917; line-height: 1.7; padding: 24px; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    h2 { font-size: 20px; font-weight: 600; margin-top: 32px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #44403C; margin-bottom: 12px; }
    ul { padding-left: 20px; }
    .updated { font-size: 13px; color: #A8A29E; margin-bottom: 24px; }
    a { color: #D4622A; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: April 10, 2026</p>

  <p>Mapd ("we", "our", or "us") operates the Mapd mobile application. This policy describes how we collect, use, and protect your information.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Account Information:</strong> When you sign in with Google, we receive your name, email address, and profile photo. This is used solely for authentication and displaying your profile within the app.</li>
    <li><strong>Saved Places:</strong> Places you save (pins), lists you create, and notes you add are stored in our database to provide the core app functionality.</li>
    <li><strong>Shared Links:</strong> When you share links from Instagram, TikTok, or Google Maps to Mapd, we process the URL to extract place information. The URLs and extracted metadata are logged for analytics and to improve the service.</li>
    <li><strong>Location Data:</strong> With your permission, we access your device's precise location to show your position on the map and to improve place search results. We do not store your location history on our servers.</li>
    <li><strong>Usage Data:</strong> We collect analytics events (such as pins saved, links processed, and features used) to understand how the app is used and to improve it. These events are linked to your user ID.</li>
    <li><strong>Diagnostics:</strong> We collect crash reports and performance data to maintain app stability. This data is not linked to your identity.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To provide and maintain the app's core features (saving places, creating lists, sharing with friends)</li>
    <li>To authenticate your account and secure your data</li>
    <li>To process shared links and extract place information</li>
    <li>To analyze usage patterns and improve the app</li>
    <li>To diagnose technical issues and fix bugs</li>
  </ul>

  <h2>Third-Party Services</h2>
  <p>We use the following third-party services to operate the app:</p>
  <ul>
    <li><strong>Google Firebase:</strong> Authentication, database, and crash reporting</li>
    <li><strong>Google Places API:</strong> Place search and details</li>
    <li><strong>Google Maps:</strong> Map display</li>
    <li><strong>Anthropic (Claude AI):</strong> Extracting place names from social media post captions (text only, no personal data is sent)</li>
  </ul>
  <p>We do not sell, rent, or share your personal information with third parties for advertising or marketing purposes.</p>

  <h2>Data Storage and Security</h2>
  <p>Your data is stored in Google Firebase (Cloud Firestore) with security rules that restrict access to authenticated users. Each user can only read and modify their own data. We use industry-standard security measures to protect your information.</p>

  <h2>Data Retention</h2>
  <p>Your account data and saved places are retained as long as your account is active. Cached data (link extractions, place lookups) expires automatically after 7–30 days. You can delete your account and all associated data at any time by contacting us.</p>

  <h2>Your Rights</h2>
  <p>You have the right to:</p>
  <ul>
    <li>Access your personal data</li>
    <li>Request correction of inaccurate data</li>
    <li>Request deletion of your account and data</li>
    <li>Export your saved places data</li>
  </ul>
  <p>To exercise any of these rights, contact us at the email below.</p>

  <h2>Children's Privacy</h2>
  <p>Mapd is not intended for children under 13. We do not knowingly collect personal information from children under 13.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy from time to time. We will notify you of significant changes through the app or by updating the date at the top of this page.</p>

  <h2>Contact Us</h2>
  <p>If you have questions about this privacy policy or your data, contact us at: <a href="mailto:mapdnyc@gmail.com">mapdnyc@gmail.com</a></p>
</body>
</html>`);
});

// Invite landing page — opens app if installed, shows download page if not
app.get('/invite/:token', (req, res) => {
  const { token } = req.params;
  const appScheme = `mapd://join/${token}`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join a list on Mapd</title>
  <meta property="og:title" content="You've been invited to a list on Mapd">
  <meta property="og:description" content="Mapd turns your saved Instagram and TikTok posts into pins on a map.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #F9F8F6;
      color: #1C1917;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .logo { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { font-size: 16px; color: #78716C; margin-bottom: 32px; line-height: 1.5; }
    .code {
      background: #FDE8DE;
      color: #D4622A;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 8px;
      font-size: 18px;
      letter-spacing: 1px;
      display: inline-block;
      margin-bottom: 32px;
    }
    .btn {
      display: block;
      width: 100%;
      max-width: 300px;
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      margin-bottom: 12px;
    }
    .btn-primary { background: #D4622A; color: #fff; }
    .btn-secondary { background: #fff; color: #1C1917; border: 1px solid #E7E5E4; }
    .stores { display: flex; gap: 12px; margin-top: 24px; }
    .stores a {
      padding: 10px 20px;
      background: #1C1917;
      color: #fff;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
    }
    .divider { color: #A8A29E; font-size: 14px; margin: 16px 0; }
    .footer { margin-top: 40px; font-size: 12px; color: #A8A29E; }
  </style>
</head>
<body>
  <div class="logo">📍</div>
  <h1>You're invited to a list on Mapd</h1>
  <p class="subtitle">Save places from Instagram & TikTok to a shared map with friends.</p>

  <a href="${appScheme}" class="btn btn-primary" id="openApp">Open in Mapd</a>

  <p class="divider">Don't have the app yet?</p>

  <p class="subtitle">Enter this invite code in the app:</p>
  <div class="code">${token}</div>

  <div class="stores">
    <a href="#">App Store</a>
    <a href="#">Google Play</a>
  </div>

  <p class="footer">Mapd — your places, on your map</p>

  <script>
    // Try to open the app, fall back gracefully
    document.getElementById('openApp').addEventListener('click', function(e) {
      e.preventDefault();
      var appUrl = '${appScheme}';
      window.location.href = appUrl;
      // If app doesn't open after 1.5s, stay on this page
      setTimeout(function() {
        // User is still here — app didn't open
      }, 1500);
    });
  </script>
</body>
</html>`);
});

// Extract metadata from a social media link
app.post('/extract', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Normalize URL for cache lookups (strip tracking params)
  const normalizedUrl = normalizeUrlForCache(url);

  // Check cache — try normalized URL first
  const cached = await getCached(normalizedUrl);
  if (cached) {
    console.log('Cache hit:', normalizedUrl.slice(0, 60));
    return res.json(cached);
  }

  // For short URLs, try resolving to canonical and check cache again
  if (url.includes('/t/') || url.includes('vm.tiktok') || url.includes('instagr.am')) {
    try {
      const resolved = await new Promise((resolve) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.request(url, { method: 'HEAD', timeout: 5000 }, (response) => {
          // Follow redirects manually
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            resolve(response.headers.location);
          } else {
            resolve(url);
          }
        });
        req.on('error', () => resolve(url));
        req.on('timeout', () => { req.destroy(); resolve(url); });
        req.end();
      });
      if (resolved !== url) {
        const normalizedCanonical = normalizeUrlForCache(resolved);
        const cachedCanonical = await getCached(normalizedCanonical);
        if (cachedCanonical) {
          console.log('Cache hit (canonical):', normalizedCanonical.slice(0, 60));
          return res.json(cachedCanonical);
        }
      }
    } catch {
      // Resolve failed — continue with yt-dlp
    }
  }

  console.log('Extracting:', url);

  try {
    const data = await runYtDlp(url);
    console.log('Extracted:', data.title?.slice(0, 60));
    // Cache by normalized URL and normalized canonical URL
    await setCache(normalizedUrl, data);
    if (data.webpage_url) {
      const normalizedCanonical = normalizeUrlForCache(data.webpage_url);
      if (normalizedCanonical !== normalizedUrl) {
        await setCache(normalizedCanonical, data);
      }
    }
    res.json(data);
  } catch (error) {
    console.error('Extraction failed:', error.message);
    res.status(422).json({ error: error.message, code: error.code || 'UNKNOWN' });
  }
});

// AI: Extract ALL places from a social media post (single consolidated call)
app.post('/ai/extract-places', async (req, res) => {
  const { title, description, hashtags, uploader, subtitles } = req.body;

  if (!title && !description && !subtitles) {
    return res.status(400).json({ error: 'title, description, or subtitles required' });
  }

  // Cache by caption + subtitle content
  const cacheKey = `ai:places:${(title || '').slice(0, 50)}:${(description || '').slice(0, 50)}:${(subtitles || '').slice(0, 30)}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const context = [
      title ? `Title: ${title}` : '',
      description ? `Caption: ${(description || '').slice(0, 1200)}` : '',
      uploader ? `Uploader: ${uploader}` : '',
      subtitles ? `Video transcript/subtitles: ${(subtitles || '').slice(0, 1500)}` : '',
      hashtags?.length ? `Hashtags: ${hashtags.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Extract ALL specific place names (restaurants, bars, cafes, shops, attractions, hotels) from this social media post.

Rules:
- Only extract NAMED businesses or attractions (not generic descriptions like "best pizza spot")
- Include the city/neighborhood if mentioned or inferrable from context
- If a full address is given, include it
- If there are multiple places, return all of them
- If NO specific named place is found, return an empty list

${context}

Return ONLY valid JSON: {"places": [{"name": "Place Name", "city": "City", "address": "full address if given, otherwise empty string"}], "count": N}`,
      }],
    });

    let text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    await setCache(cacheKey, parsed);
    res.json(parsed);
  } catch (error) {
    console.error('AI extract-places failed:', error.message);
    res.json({ places: [], count: 0 });
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
  const cached = await getCached(cacheKey);
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
      await setCache(cacheKey, result);
      return res.json(result);
    }
    const result = { place: null };
    await setCache(cacheKey, result);
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
  const cached = await getCached(cacheKey);
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
      await setCache(cacheKey, result);
      return res.json(result);
    }

    const parsed = JSON.parse(text);
    const result = { places: parsed?.places || [] };
    await setCache(cacheKey, result);
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

        // Collect slide thumbnails for carousels (for vision-based place extraction)
        const entries = json.entries || [];
        const slideThumbnails = entries
          .map((e) => e.thumbnail || e.thumbnails?.[0]?.url || null)
          .filter(Boolean)
          .slice(0, 10); // Cap at 10 slides

        // Try to extract subtitles/captions (non-blocking)
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

/** Extract subtitles/captions from a video URL via yt-dlp */
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

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      cleanup(tmpDir);
      resolve(null);
    }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      // Find any subtitle file that was written
      try {
        const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.vtt') || f.endsWith('.srt'));
        if (files.length === 0) {
          cleanup(tmpDir);
          return resolve(null);
        }

        const subText = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
        cleanup(tmpDir);

        // Parse VTT/SRT: strip timestamps and formatting, keep just the text
        const lines = subText.split('\n')
          .filter((line) => {
            // Skip VTT header, timestamps, empty lines, and position tags
            if (line.startsWith('WEBVTT')) return false;
            if (line.startsWith('Kind:') || line.startsWith('Language:')) return false;
            if (/^\d{2}:\d{2}/.test(line)) return false;
            if (/^\d+$/.test(line.trim())) return false;
            if (line.trim() === '') return false;
            return true;
          })
          .map((line) => line.replace(/<[^>]+>/g, '').trim()) // strip HTML tags
          .filter(Boolean);

        // Deduplicate consecutive identical lines (VTT often repeats)
        const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
        const transcript = deduped.join(' ').slice(0, 3000); // cap at 3000 chars

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mapd link extractor running on port ${PORT}`);
});
