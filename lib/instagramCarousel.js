// Custom Instagram photo-post extractor.
//
// yt-dlp's Instagram extractor returns an empty `entries[]` for /p/ carousels
// from unauthenticated callers, so is_carousel never fires and vision never
// runs. The public embed page (/p/<shortcode>/embed/) exposes the full
// carousel via doubly-escaped JSON embedded in a JS string literal. Peel two
// layers of backslash escapes, regex out the display_urls, and dedupe by the
// stable `<ids>_n.jpg` filename segment to drop CDN resolution variants.
//
// Output shape matches fetchTikTokPhotoPost so downstream code (vision,
// cache, client) is unchanged.

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 15000;
const MAX_SLIDES = 20;

function isInstagramPostUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Matches instagram.com/p/<shortcode> and instagram.com/<user>/p/<shortcode>.
  // Excludes /reel/, /reels/, /stories/, /tv/, /live/ by structure (those paths
  // don't contain /p/).
  return /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?p\/[A-Za-z0-9_-]+/i.test(url);
}

function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?p\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function unescapeJsonString(s) {
  // Captured group may contain JSON escapes (\n, \t, \", \\, \uXXXX). JSON.parse
  // of a wrapped literal is the safest decoder.
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

async function fetchInstagramCarouselPost(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) {
    const err = new Error('Could not extract Instagram shortcode');
    err.code = 'INSTAGRAM_EMBED_EXTRACT_FAILED';
    throw err;
  }

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
  const canonicalUrl = `https://www.instagram.com/p/${shortcode}/`;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  try {
    const response = await fetch(embedUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = new Error(`Instagram embed fetch returned HTTP ${response.status}`);
      err.code = response.status === 403 || response.status === 429 ? 'IP_BLOCKED' : 'INSTAGRAM_EMBED_EXTRACT_FAILED';
      throw err;
    }
    html = await response.text();
  } finally {
    clearTimeout(abortTimer);
  }

  // The embed page contains a JSON blob whose string values are stored inside
  // an outer JS string literal, so quotes/slashes are backslash-escaped twice.
  // Peel both layers before regexing.
  const peeled = html
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');

  // Extract all display_url image references. CDN serves the same image at
  // multiple resolutions (distinct ?stp= query params), so dedupe by the
  // stable filename segment to get one URL per carousel slide.
  const urlMatches = [...peeled.matchAll(/"display_url":"(https:\/\/scontent[^"]+)"/g)].map((m) => m[1]);
  const coreRe = /\/(\d{6,}_\d+_\d+_n\.jpg)/;
  const seen = new Set();
  const slideThumbnails = [];
  for (const u of urlMatches) {
    const core = coreRe.exec(u);
    const key = core ? core[1] : u.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    slideThumbnails.push(u);
    if (slideThumbnails.length >= MAX_SLIDES) break;
  }

  if (slideThumbnails.length === 0) {
    // Login wall, private post, age-gated, or format drift. Let the caller
    // fall through to yt-dlp so we still get a caption for text-only AI.
    const err = new Error('Instagram embed returned no carousel images');
    err.code = 'INSTAGRAM_EMBED_EXTRACT_FAILED';
    throw err;
  }

  // Caption: JSON-escaped text inside edge_media_to_caption.
  let description = '';
  const capMatch = peeled.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
  if (capMatch) {
    description = unescapeJsonString(capMatch[1]);
  }

  const uploaderMatch = peeled.match(/"owner":\{[^}]*?"username":"([^"]+)"/);
  const uploader = uploaderMatch ? uploaderMatch[1] : '';

  const captionHashtags = (description.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || []).map((t) =>
    t.slice(1).toLowerCase(),
  );
  const hashtags = [...new Set(captionHashtags)];

  const title = description.slice(0, 80) || `Post by ${uploader}`.trim();

  return {
    title,
    description,
    thumbnail_url: slideThumbnails[0] || '',
    uploader,
    hashtags,
    webpage_url: canonicalUrl,
    location: null,
    is_carousel: slideThumbnails.length > 1,
    slide_count: slideThumbnails.length,
    slide_thumbnails: slideThumbnails,
    subtitles: null,
  };
}

module.exports = { fetchInstagramCarouselPost, isInstagramPostUrl };
