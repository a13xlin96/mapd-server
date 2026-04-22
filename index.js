const express = require('express');
const cors = require('cors');
const { anthropic } = require('./lib/anthropic');
const { firestore, admin } = require('./lib/firestore');
const { getCached, setCache, normalizeUrlForCache } = require('./lib/cache');
const { runYtDlp } = require('./lib/ytdlp');
const { fetchTikTokPhotoPost, isTikTokPhotoUrl } = require('./lib/tiktokPhoto');
const { runEnrichment } = require('./enrich');
require('./lib/enrichmentSweeper'); // boots the orphan-job sweeper

const app = express();
app.use(cors());
app.use(express.json());

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

  // For short URLs, try resolving to canonical and check cache again.
  // We also preserve the resolved URL so the extractor router below can
  // decide between yt-dlp (videos) and the custom TikTok photo extractor.
  let canonicalUrl = url;
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
        canonicalUrl = resolved;
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
    let data;
    if (isTikTokPhotoUrl(canonicalUrl)) {
      console.log('Using custom TikTok photo extractor for', canonicalUrl.slice(0, 80));
      data = await fetchTikTokPhotoPost(canonicalUrl);
    } else {
      data = await runYtDlp(url);
    }
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
  const {
    title,
    description,
    hashtags,
    uploader,
    subtitles,
    mentionedAccounts,
    collaborators,
  } = req.body;

  if (!title && !description && !subtitles) {
    return res.status(400).json({ error: 'title, description, or subtitles required' });
  }

  // Cache by caption + subtitle + mentions content (mentions change the answer)
  const mentionsKey = Array.isArray(mentionedAccounts) ? mentionedAccounts.slice(0, 5).join(',') : '';
  const cacheKey = `ai:places:${(title || '').slice(0, 50)}:${(description || '').slice(0, 50)}:${(subtitles || '').slice(0, 30)}:${mentionsKey.slice(0, 50)}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const mentionLines = [];
    if (Array.isArray(mentionedAccounts) && mentionedAccounts.length) {
      mentionLines.push(
        `Mentioned accounts (may or may not be venues): ${mentionedAccounts.slice(0, 5).map((h) => '@' + h).join(' ')}`,
      );
    }
    if (Array.isArray(collaborators) && collaborators.length) {
      mentionLines.push(
        `Collaborators / co-authors: ${collaborators.slice(0, 3).map((h) => '@' + h).join(' ')}`,
      );
    }

    const context = [
      title ? `Title: ${title}` : '',
      description ? `Caption: ${(description || '').slice(0, 1200)}` : '',
      uploader ? `Uploader: ${uploader}` : '',
      subtitles ? `Video transcript/subtitles: ${(subtitles || '').slice(0, 3000)}` : '',
      hashtags?.length ? `Hashtags: ${hashtags.join(', ')}` : '',
      ...mentionLines,
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Extract ALL specific place names (restaurants, bars, cafes, shops, attractions, hotels) from this social media post.

Rules:
- Only extract NAMED businesses or attractions (not generic descriptions like "best pizza spot")
- Include the city/neighborhood if mentioned or inferrable from context
- If a full address is given, include it
- If there are multiple places, return all of them
- If NO specific named place is found, return an empty list
- For each place, record which signal it came from: "caption", "hashtag", "transcript", or "handle" (a venue-looking @mention or collaborator). When uncertain about a handle being a venue, OMIT it — do not guess.

${context}

Return ONLY valid JSON: {"places": [{"name": "Place Name", "city": "City", "address": "full address if given, otherwise empty string", "source": "caption" | "hashtag" | "transcript" | "handle"}], "count": N}`,
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

// AI: Infer city/country for each place using ALL siblings in the list as context.
// Used by the Google Takeout import flow and by the "Re-resolve from link" pin action
// when the original URL doesn't carry coordinates.
app.post('/ai/infer-place-regions', async (req, res) => {
  const { places, listName, siblingPlaces } = req.body;

  if (!Array.isArray(places) || places.length === 0) {
    return res.status(400).json({ error: 'places array required' });
  }

  const cleanPlaces = places
    .map((p) => ({ name: String(p?.name || '').trim(), url: String(p?.url || '').trim() }))
    .filter((p) => p.name);
  const cleanSiblings = Array.isArray(siblingPlaces)
    ? siblingPlaces.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const cleanListName = String(listName || '').trim();

  if (cleanPlaces.length === 0) {
    return res.status(400).json({ error: 'no valid place names' });
  }

  const cacheKey = `ai:infer-regions:${cleanListName}:${JSON.stringify(cleanPlaces)}:${JSON.stringify(cleanSiblings)}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const allContextNames = Array.from(new Set([
      ...cleanPlaces.map((p) => p.name),
      ...cleanSiblings,
    ]));

    const placesBlock = cleanPlaces
      .map((p, i) => `${i + 1}. "${p.name}"${p.url ? `\n   URL: ${p.url}` : ''}`)
      .join('\n');

    const prompt = `You are identifying the location of places saved in a user's map list.

Use ALL available context to disambiguate. A place name alone ("Joe's Pizza") is often ambiguous because the same name exists in many cities worldwide. But when sibling places in the same list clearly point to one region, use that regional context to place the ambiguous ones.

Priority of signals (strongest first):
1. The place name itself if it's unique or tied to a landmark ("Sagrada Familia")
2. Sibling places in the same list — if most siblings are in Barcelona, an ambiguous "Joe's Pizza" in that list is very likely also in Barcelona
3. The list name if it names a place ("Spain", "Tokyo Trip")
4. Any hints in the URL slug

Return "confidence": "low" and null city/country ONLY if the name is so generic AND the siblings give no regional signal. When siblings cluster in one region, treat that as strong evidence and use "medium" or "high".

List name: ${cleanListName ? `"${cleanListName}"` : '(none)'}
All places in this list (for regional context): ${allContextNames.map((n) => `"${n}"`).join(', ')}

Places to identify:
${placesBlock}

Return ONLY valid JSON in this exact shape:
{"results":[{"name":"<exact input name>","city":"<city or null>","country":"<country or null>","confidence":"high|medium|low"}]}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];

    // Normalize: ensure every input place has a corresponding result.
    const byName = new Map(results.map((r) => [String(r?.name || '').trim(), r]));
    const normalized = cleanPlaces.map((p) => {
      const r = byName.get(p.name) || {};
      const confidence = ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low';
      return {
        name: p.name,
        city: r.city || null,
        country: r.country || null,
        confidence,
      };
    });

    const response = { results: normalized };
    await setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('AI infer-place-regions failed:', error.message);
    res.json({
      results: cleanPlaces.map((p) => ({ name: p.name, city: null, country: null, confidence: 'low' })),
    });
  }
});

// AI Vision: Extract place names from carousel slide images
app.post('/ai/vision-extract', async (req, res) => {
  const { imageUrls, contentId, caption, hashtags, subtitles } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'imageUrls array required' });
  }

  // Prefer content-ID for cache key so shares of the same post dedupe across
  // users (IG/TikTok CDN URLs carry rotating signed query params otherwise).
  // Fall back to URL prefix when no contentId is provided.
  const cacheKey = contentId
    ? `ai:vision:${contentId}`
    : `ai:vision:${imageUrls[0]?.slice(0, 60)}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Send up to 10 slides (Instagram carousel max, matches yt-dlp output).
    const imageContent = imageUrls.slice(0, 10).map((url) => ({
      type: 'image',
      source: { type: 'url', url },
    }));

    const captionLine = caption ? `Caption: "${String(caption).slice(0, 600)}"` : 'Caption: (none)';
    const hashtagLine = Array.isArray(hashtags) && hashtags.length
      ? `Hashtags: ${hashtags.slice(0, 20).map((h) => '#' + h).join(' ')}`
      : 'Hashtags: (none)';
    const subtitleLine = subtitles
      ? `Transcript: "${String(subtitles).slice(0, 1000)}"`
      : 'Transcript: (none)';

    const promptText = [
      'These are slides from a social media carousel post. Text context from the post is below; use it together with the images.',
      '',
      captionLine,
      hashtagLine,
      subtitleLine,
      '',
      'Read any place names, restaurant names, bar names, cafe names, or specific venues that appear as text overlays on the images OR are clearly referenced by the caption / hashtags / transcript. Use the text context to disambiguate overlays (e.g. "JUNO" plus coffee cues = Juno Cafe).',
      '',
      'Do NOT return bare city, country, or region names ("Tokyo", "Italy", "NYC") — only specific venues.',
      'Ignore navigational text ("SWIPE", arrows), user handles that are not clearly venue accounts, and generic hashtags.',
      '',
      'Return ONLY valid JSON: {"places": ["Place Name 1", "Place Name 2"]} or {"places": []} if none are visible.',
    ].join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          { type: 'text', text: promptText },
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

// Verify a Firebase ID token on the Authorization header and attach the decoded
// uid to req.authUid. Rejects with 401 on missing/invalid token.
async function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.authUid = decoded.uid;
    return next();
  } catch (err) {
    console.warn('Auth verify failed:', err.message);
    return res.status(401).json({ error: 'Invalid ID token' });
  }
}

// Server-side enrichment. Client POSTs URL + jobId, receives 202 immediately,
// processing continues async and writes results to enrichmentJobs/{jobId}.
app.post('/enrich', authenticateRequest, async (req, res) => {
  const { url, userId, captionText, jobId } = req.body || {};
  console.log(`[/enrich] job=${jobId || '?'} user=${userId || '?'} url=${url || '?'}`);

  if (!url || !userId || !jobId) {
    return res.status(400).json({ error: 'url, userId, and jobId are required' });
  }
  if (userId !== req.authUid) {
    return res.status(403).json({ error: 'userId does not match authenticated user' });
  }
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore not configured on server' });
  }

  try {
    const jobRef = firestore.collection('enrichmentJobs').doc(jobId);
    const snap = await jobRef.get();

    if (snap.exists) {
      const existing = snap.data();
      if (existing.status && existing.status !== 'processing') {
        return res.status(200).json({ jobId, status: existing.status });
      }
      // A processing job with same id — treat as idempotent retry
      return res.status(202).json({ jobId, status: 'processing' });
    }

    await jobRef.set({
      userId,
      url,
      status: 'processing',
      createdAt: firestoreTs(),
      updatedAt: firestoreTs(),
    });

    // Fire-and-forget: the response returns immediately; the pipeline runs in the background
    runEnrichment(jobId, url, userId, captionText || '').catch((err) => {
      console.error(`runEnrichment unhandled error for ${jobId}:`, err);
    });

    return res.status(202).json({ jobId, status: 'processing' });
  } catch (err) {
    console.error('/enrich failed:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

function firestoreTs() {
  const admin = require('firebase-admin');
  return admin.firestore.FieldValue.serverTimestamp();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mapd link extractor running on port ${PORT}`);
});
