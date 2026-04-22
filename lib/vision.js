// Shared Claude Haiku vision extraction for carousel slide images.
// Used by both the /ai/vision-extract HTTP endpoint and the /enrich
// server-driven pipeline so they can't drift apart again.

const { anthropic } = require('./anthropic');
const { getCached, setCache } = require('./cache');

// Up to 20 slides — matches Instagram carousel max and aligns with the
// TikTok/yt-dlp upstream caps.
const SLIDE_CAP = 20;

// Bump this when the prompt or response shape changes so stale cache hits
// (string-format places, missing location hints, etc.) don't mask the new
// behavior.
const CACHE_VERSION = 'v3';

function buildCacheKey({ contentId, imageUrls }) {
  // Prefer content-ID so shares of the same post dedupe across users
  // whose CDN URLs carry rotating signed query params. Fall back to the
  // first URL's prefix when contentId is missing.
  if (contentId) return `ai:vision:${CACHE_VERSION}:${contentId}`;
  return `ai:vision:${CACHE_VERSION}:${(imageUrls?.[0] || '').slice(0, 60)}`;
}

function buildPrompt({ caption, hashtags, subtitles }) {
  const captionLine = caption
    ? `Caption: "${String(caption).slice(0, 600)}"`
    : 'Caption: (none)';
  const hashtagLine = Array.isArray(hashtags) && hashtags.length
    ? `Hashtags: ${hashtags.slice(0, 20).map((h) => '#' + h).join(' ')}`
    : 'Hashtags: (none)';
  const subtitleLine = subtitles
    ? `Transcript: "${String(subtitles).slice(0, 1000)}"`
    : 'Transcript: (none)';
  return [
    'These are slides from a social media carousel post. Text context from the post is below; use it together with the images.',
    '',
    captionLine,
    hashtagLine,
    subtitleLine,
    '',
    'Read any place names, restaurant names, bar names, cafe names, or specific venues that appear as text overlays on the images OR are clearly referenced by the caption / hashtags / transcript. Use the text context to disambiguate overlays (e.g. "JUNO" plus coffee cues = Juno Cafe).',
    '',
    'For EACH place, also identify its city/region/country from any signal available:',
    '- Hashtags like #bali, #canggu, #nyc, #tokyo',
    '- Location names in the caption or transcript',
    '- Location text overlaid on the images',
    'This disambiguates common chain names (e.g. "Mason" alone matches a US chain but "Mason Bali" finds the actual venue). If truly no location context is present, use "" for location.',
    '',
    'Do NOT return bare city, country, or region names ("Tokyo", "Italy", "NYC") as their own entries — only specific venues.',
    'Ignore navigational text ("SWIPE", arrows), user handles that are not clearly venue accounts, and generic hashtags.',
    '',
    'Return ONLY valid JSON:',
    '{"places": [{"name": "Venue Name", "location": "City or Region, Country"}, ...]}',
    'or {"places": []} if no specific venues are visible.',
  ].join('\n');
}

// Normalize a single AI place item into {name, location} with string fields
// defensively coerced. Old-format "PlaceName" strings accepted for back-compat.
function normalizePlaceItem(item) {
  if (typeof item === 'string') {
    return { name: item.trim(), location: '' };
  }
  if (item && typeof item === 'object') {
    return {
      name: String(item.name || '').trim(),
      location: String(item.location || item.city || item.region || '').trim(),
    };
  }
  return null;
}

async function extractPlacesFromSlides({ imageUrls, contentId, caption, hashtags, subtitles }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { places: [] };
  }

  const cacheKey = buildCacheKey({ contentId, imageUrls });
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // Fetch images server-side and pass as base64. Anthropic respects the
  // source host's robots.txt when using url sources, and cdninstagram.com
  // disallows their crawler — so IG carousels come back 400. Fetching
  // ourselves bypasses that restriction uniformly for all sources.
  const slice = imageUrls.slice(0, SLIDE_CAP);
  const fetched = await Promise.all(
    slice.map(async (url) => {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        if (!resp.ok) return null;
        const mediaType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        const buf = Buffer.from(await resp.arrayBuffer());
        return { mediaType, data: buf.toString('base64') };
      } catch {
        return null;
      }
    }),
  );
  const imageContent = fetched.filter(Boolean).map(({ mediaType, data }) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  }));
  if (imageContent.length === 0) {
    return { places: [], _error: 'All slide images failed to fetch' };
  }

  const promptText = buildPrompt({ caption, hashtags, subtitles });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
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
      return result;
    }

    const parsed = JSON.parse(text);
    const rawPlaces = Array.isArray(parsed?.places) ? parsed.places : [];
    const places = rawPlaces
      .map(normalizePlaceItem)
      .filter((p) => p && p.name.length > 0);
    const result = { places };
    await setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error('vision extractPlacesFromSlides failed:', error.message, error.stack?.split('\n').slice(0, 3).join(' | '));
    // Don't cache errors — next call should retry.
    // Surface the error in the response so /ai/vision-extract callers can see
    // what actually broke (Anthropic API error, rate limit, malformed URL, etc).
    return { places: [], _error: String(error.message || error).slice(0, 500) };
  }
}

module.exports = { extractPlacesFromSlides };
