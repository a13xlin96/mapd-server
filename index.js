const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk').default;
const { chromium } = require('playwright');

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
        content: `Extract the real-world place (restaurant, bar, shop, attraction, etc.) from this social media caption. Return ONLY valid JSON, nothing else.\n\nCaption:\n${caption}\n\nReturn: {"name": "place name", "city": "city name", "country": "country name"}\nIf no specific place is mentioned, return: null`,
      }],
    });

    const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

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

    const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

    if (!text) {
      return res.json({ match: true, betterQuery: null });
    }

    const parsed = JSON.parse(text);
    res.json({
      match: parsed?.match ?? true,
      betterQuery: parsed?.betterQuery || null,
    });
  } catch (error) {
    console.error('AI verify-place failed:', error.message);
    res.json({ match: true, betterQuery: null });
  }
});

// Debug: see what Playwright renders for a Google Maps list page
app.post('/debug/page-snapshot', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(5000);

    const snapshot = await page.evaluate(() => {
      const finalUrl = window.location.href;
      const title = document.title;
      const hasConsent = !!document.querySelector('[aria-label*="consent"], [aria-label*="cookie"], [aria-label*="Accept"]');

      // Get ALL text content from the page body, trimmed
      const bodyText = document.body?.innerText?.slice(0, 3000) || '';

      // Get all elements and their tags/classes to understand DOM structure
      const allElements = Array.from(document.querySelectorAll('*')).slice(0, 200).map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        class: el.className?.toString?.()?.slice(0, 80),
        ariaLabel: el.getAttribute('aria-label')?.slice(0, 80),
        childCount: el.children.length,
      })).filter(el => el.role || el.ariaLabel);

      // Check for links anywhere
      const allLinks = Array.from(document.querySelectorAll('a')).slice(0, 30).map(a => ({
        href: a.href?.slice(0, 200),
        text: a.textContent?.trim().slice(0, 100),
      }));

      return { finalUrl, title, hasConsent, bodyText, allElements, allLinks };
    });

    await browser.close();
    res.json(snapshot);
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// Import places from a shared Google Maps list link
app.post('/import/google-maps-list', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate it's a Google Maps URL
  const isGoogleMaps = url.includes('google.com/maps') || url.includes('maps.google')
    || url.includes('goo.gl/maps') || url.includes('maps.app.goo.gl');
  if (!isGoogleMaps) {
    return res.status(400).json({ error: 'Not a Google Maps URL' });
  }

  console.log('Importing Google Maps list:', url);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    // Navigate to the list URL and wait for content to render
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // Google Maps lists load content dynamically — wait for the feed to appear
    // Try multiple selectors since Google's DOM changes frequently
    try {
      await page.waitForSelector('div[role="feed"], div[role="listbox"], a[href*="/place/"]', { timeout: 10000 });
    } catch {
      // Selector didn't appear — page might still have content, continue
    }
    await page.waitForTimeout(2000);

    // Scroll down to trigger lazy-loaded items
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
        else window.scrollBy(0, 800);
      });
      await page.waitForTimeout(1000);
    }

    // Extract places using multiple strategies
    const places = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      function addPlace(name, url, lat, lng) {
        const clean = name.trim();
        if (clean.length < 2 || clean.length > 100) return;
        if (seen.has(clean.toLowerCase())) return;
        // Skip generic/UI text
        const skip = ['directions', 'share', 'save', 'send', 'google maps', 'map', 'list', 'more', 'open', 'close', 'reviews', 'photos', 'about', 'overview'];
        if (skip.includes(clean.toLowerCase())) return;
        // Skip if it's just a number or rating
        if (/^[\d.]+$/.test(clean)) return;
        seen.add(clean.toLowerCase());
        results.push({ name: clean, url: url || null, lat: lat || null, lng: lng || null });
      }

      // Strategy 1: Links with /place/ in href (most reliable)
      const placeLinks = document.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"]');
      for (const link of placeLinks) {
        const href = link.getAttribute('href') || '';
        const nameMatch = href.match(/\/place\/([^/@?]+)/);
        if (nameMatch) {
          const name = decodeURIComponent(nameMatch[1]).replace(/\+/g, ' ');
          const coordMatch = href.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
          const fullUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
          addPlace(name, fullUrl, coordMatch?.[1], coordMatch?.[2]);
        }
      }

      // Strategy 2: aria-label on clickable elements (Google Maps uses these heavily)
      if (results.length === 0) {
        const labeled = document.querySelectorAll('a[aria-label], div[aria-label][role="button"]');
        for (const el of labeled) {
          const label = el.getAttribute('aria-label') || '';
          // Filter: place names are usually short, don't contain action verbs
          if (label.length > 3 && label.length < 80 && !label.includes('Close') && !label.includes('Back')) {
            const href = el.getAttribute('href') || '';
            addPlace(label, href.includes('/place/') ? href : null, null, null);
          }
        }
      }

      // Strategy 3: fontHeadlineSmall class (Google Maps place name styling)
      if (results.length === 0) {
        const headings = document.querySelectorAll('.fontHeadlineSmall, .fontTitleSmall, [data-item-id] .fontBodyMedium:first-child');
        for (const el of headings) {
          const text = el.textContent?.trim() || '';
          addPlace(text, null, null, null);
        }
      }

      // Strategy 4: Feed items — each item in a role="feed" typically has a place name as the first bold text
      if (results.length === 0) {
        const feedItems = document.querySelectorAll('div[role="feed"] > div');
        for (const item of feedItems) {
          // Find the first text element that looks like a place name (bold, short)
          const bold = item.querySelector('span[style*="font-weight"], b, strong, .fontBodyMedium');
          if (bold) {
            const text = bold.textContent?.trim() || '';
            addPlace(text, null, null, null);
          }
        }
      }

      return results;
    });

    await browser.close();
    browser = null;

    if (places.length === 0) {
      return res.json({
        places: [],
        listName: 'Google Maps Import',
        error: 'No places found in this list. Make sure the list is shared publicly.',
      });
    }

    console.log(`Found ${places.length} places in Google Maps list`);
    res.json({ places, listName: 'Google Maps Import' });
  } catch (error) {
    console.error('Google Maps list import failed:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Failed to load Google Maps list. Make sure the link is a shared list.' });
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
