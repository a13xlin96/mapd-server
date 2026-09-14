const {fetchSourceHtml} = require('./sourceFetch');
// Canonical public-page reader; upstream access can still be blocked.
const {parseInstagramPost,assertReadableInstagramPost} = require('./postMetadata');
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';


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

  const html = await fetchSourceHtml(canonicalUrl, {'User-Agent':MOBILE_UA,Accept:'text/html,application/xhtml+xml'});

  const metadata = parseInstagramPost(html, shortcode);
  assertReadableInstagramPost(metadata);
  const ogDescription = metadata.caption || metadata.page.description;
  const ogTitle = metadata.page.title;
  const thumbnail = metadata.page.image;
  const ogUrl = metadata.page.url || canonicalUrl;

  if (!ogDescription && !ogTitle) {
    // Login wall, age-gated, removed, or page format drift. Let caller fall
    // through to yt-dlp.
    const err = new Error('Instagram reel page returned no OG metadata');
    err.code = 'INSTAGRAM_REEL_EXTRACT_FAILED';
    throw err;
  }

  const description = stripOgPrefix(ogDescription) || ogTitle;

  // Username: prefer og:url path (canonical w/ owner) over original URL.
  const uploader = metadata.uploader || extractUploaderFromUrl(ogUrl) || extractUploaderFromUrl(url);

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
    location: metadata.location || null,
    accountTags: metadata.accountTags,
    collaborators: metadata.collaborators,
    tagMetadataAvailable: metadata.tagMetadataAvailable,
    accountTagCoverage: metadata.accountTagCoverage,
    mediaScope: metadata.tagMetadataAvailable ? 'post' : 'page',
    is_carousel: false,
    slide_count: 1,
    slide_thumbnails: thumbnail ? [thumbnail] : [],
    subtitles: null, // OG scrape can't get subtitles
  };
}

module.exports = { fetchInstagramReelPost, isInstagramReelUrl };
