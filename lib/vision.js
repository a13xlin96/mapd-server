// Shared Claude Haiku vision extraction for carousel slide images.
// Used by both the /ai/vision-extract HTTP endpoint and the /enrich
// server-driven pipeline so they can't drift apart again.

const { anthropic } = require('./anthropic');
const { getCached, setCache } = require('./cache');

// Up to 10 slides — matches Instagram carousel max and yt-dlp output cap.
const SLIDE_CAP = 10;

function buildCacheKey({ contentId, imageUrls }) {
  // Prefer content-ID so shares of the same post dedupe across users
  // whose CDN URLs carry rotating signed query params. Fall back to the
  // first URL's prefix when contentId is missing.
  if (contentId) return `ai:vision:${contentId}`;
  return `ai:vision:${(imageUrls?.[0] || '').slice(0, 60)}`;
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
    'Do NOT return bare city, country, or region names ("Tokyo", "Italy", "NYC") — only specific venues.',
    'Ignore navigational text ("SWIPE", arrows), user handles that are not clearly venue accounts, and generic hashtags.',
    '',
    'Return ONLY valid JSON: {"places": ["Place Name 1", "Place Name 2"]} or {"places": []} if none are visible.',
  ].join('\n');
}

async function extractPlacesFromSlides({ imageUrls, contentId, caption, hashtags, subtitles }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { places: [] };
  }

  const cacheKey = buildCacheKey({ contentId, imageUrls });
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const imageContent = imageUrls.slice(0, SLIDE_CAP).map((url) => ({
    type: 'image',
    source: { type: 'url', url },
  }));

  const promptText = buildPrompt({ caption, hashtags, subtitles });

  try {
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
      return result;
    }

    const parsed = JSON.parse(text);
    const result = { places: Array.isArray(parsed?.places) ? parsed.places : [] };
    await setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error('vision extractPlacesFromSlides failed:', error.message);
    // Don't cache errors — next call should retry.
    return { places: [] };
  }
}

module.exports = { extractPlacesFromSlides };
