// Instagram reel caption extractor.
//
// Reels (/reel/<shortcode>) currently route to yt-dlp, which Instagram's
// anti-bot system aggressively blocks on Render's IP — empty media response,
// rate-limit, or login-required errors come back. The /embed/ endpoint
// reels expose is a JS-rendered shell with no caption in the initial HTML
// (verified 2026-04-26 by curl), unlike /p/ posts where /embed/ is fully SSR.
//
// What DOES work: the canonical /reel/<shortcode>/ URL is server-rendered
// and includes <meta property="og:description"> with the caption (truncated
// to ~800 chars but enough to feed AI place-extraction). og:image gives a
// thumbnail. og:title gives the post title (often the start of the caption).
//
// We lose the video subtitles track (yt-dlp's specialty), so reels where
// the place is mentioned only in voiceover/on-screen text won't match.
// Acceptable trade — caption-driven reels were 0% before this change.
//
// Output shape mirrors fetchInstagramCarouselPost so downstream code
// (buildPinFromExtract, AI, cache, client) is unchanged.

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 15000;

function isInstagramReelUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Matches instagram.com/reel/<shortcode> and instagram.com/<user>/reel/<shortcode>.
  return /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?reel\/[A-Za-z0-9_-]+/i.test(url);
}

function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?reel\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function extractUploaderFromUrl(url) {
  // Username appears in the path for some share URLs: /<user>/reel/<id>/
  const m = url.match(/instagram\.com\/([A-Za-z0-9_.]+)\/reel\//i);
  return m ? m[1] : '';
}

// Decode HTML entities (&quot; &amp; &#x1f962; &#xff9f; etc.) without pulling
// in a heavy dependency. Covers named entities + decimal + hex numeric refs.
function decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// IG's og:description prefixes the caption with engagement + author + date:
//   "3,372 likes, 44 comments - suzyandaustin on February 1, 2026: \"caption...\""
//   "c.ndyc on April 25, 2026: \"caption...\""
// Both end with `: "<caption>"`. Strip the prefix to get just the caption.
// Falls back to the full string if no quoted caption is found (defensive).
function stripOgPrefix(ogDesc) {
  if (!ogDesc) return '';
  // Match the LAST `: "..."` segment to avoid colon-bearing prefixes confusing
  // earlier matches. Caption itself can contain colons.
  const m = ogDesc.match(/:\s*"([\s\S]*)"\s*\.?\s*$/);
  if (m) return m[1].trim();
  return ogDesc.trim();
}

async function fetchInstagramReelPost(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) {
    const err = new Error('Could not extract Instagram reel shortcode');
    err.code = 'INSTAGRAM_REEL_EXTRACT_FAILED';
    throw err;
  }

  const canonicalUrl = `https://www.instagram.com/reel/${shortcode}/`;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  try {
    const response = await fetch(canonicalUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = new Error(`Instagram reel fetch returned HTTP ${response.status}`);
      err.code = response.status === 403 || response.status === 429 ? 'IP_BLOCKED' : 'INSTAGRAM_REEL_EXTRACT_FAILED';
      throw err;
    }
    html = await response.text();
  } finally {
    clearTimeout(abortTimer);
  }

  const ogDescMatch = html.match(/<meta property="og:description"[^>]*content="([^"]+)"/);
  const ogTitleMatch = html.match(/<meta property="og:title"[^>]*content="([^"]+)"/);
  const ogImageMatch = html.match(/<meta property="og:image"[^>]*content="([^"]+)"/);
  const ogUrlMatch = html.match(/<meta property="og:url"[^>]*content="([^"]+)"/);

  const ogDescription = ogDescMatch ? decodeHtmlEntities(ogDescMatch[1]) : '';
  const ogTitle = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]) : '';
  const thumbnail = ogImageMatch ? decodeHtmlEntities(ogImageMatch[1]) : '';
  const ogUrl = ogUrlMatch ? decodeHtmlEntities(ogUrlMatch[1]) : canonicalUrl;

  if (!ogDescription && !ogTitle) {
    // Login wall, age-gated, removed, or page format drift. Let caller fall
    // through to yt-dlp.
    const err = new Error('Instagram reel page returned no OG metadata');
    err.code = 'INSTAGRAM_REEL_EXTRACT_FAILED';
    throw err;
  }

  const description = stripOgPrefix(ogDescription) || ogTitle;

  // Username: prefer og:url path (canonical w/ owner) over original URL.
  const uploader = extractUploaderFromUrl(ogUrl) || extractUploaderFromUrl(url);

  const captionHashtags = (description.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || []).map((t) =>
    t.slice(1).toLowerCase(),
  );
  const hashtags = [...new Set(captionHashtags)];

  const title = (description.slice(0, 80) || ogTitle || `Reel by ${uploader}`).trim();

  return {
    title,
    description,
    thumbnail_url: thumbnail,
    uploader,
    hashtags,
    webpage_url: ogUrl || canonicalUrl,
    location: null,
    is_carousel: false,
    slide_count: 1,
    slide_thumbnails: thumbnail ? [thumbnail] : [],
    subtitles: null, // OG scrape can't get subtitles
  };
}

module.exports = { fetchInstagramReelPost, isInstagramReelUrl };
