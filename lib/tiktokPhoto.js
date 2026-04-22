// Custom TikTok photo-post extractor.
//
// yt-dlp's TikTok extractor does not support /photo/ URLs (only /video/). For
// photo posts we fetch the web page anonymously, extract the embedded
// `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON payload, and walk to the image
// post data. Output shape matches runYtDlp() so downstream code (caching,
// AI extract, client) is unchanged.

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 15000;

function isTikTokPhotoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /tiktok\.com\/@[^/]+\/photo\/\d+/.test(url);
}

async function fetchTikTokPhotoPost(url) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  let finalUrl;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = new Error(`TikTok fetch returned HTTP ${response.status}`);
      err.code = response.status === 403 || response.status === 429 ? 'IP_BLOCKED' : 'TIKTOK_PHOTO_EXTRACT_FAILED';
      throw err;
    }
    html = await response.text();
    finalUrl = response.url;
  } finally {
    clearTimeout(abortTimer);
  }

  const match = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) {
    const err = new Error('TikTok rehydration payload missing from page HTML');
    err.code = 'TIKTOK_PHOTO_EXTRACT_FAILED';
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch (parseErr) {
    const err = new Error('Failed to parse TikTok rehydration JSON');
    err.code = 'TIKTOK_PHOTO_EXTRACT_FAILED';
    throw err;
  }

  const itemStruct =
    payload?.__DEFAULT_SCOPE__?.['webapp.reflow.video.detail']?.itemInfo?.itemStruct ||
    payload?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!itemStruct) {
    const err = new Error('TikTok itemStruct not found in rehydration payload');
    err.code = 'TIKTOK_PHOTO_EXTRACT_FAILED';
    throw err;
  }

  const imagePost = itemStruct.imagePost;
  const images = Array.isArray(imagePost?.images) ? imagePost.images : [];
  if (images.length === 0) {
    // Not an image post — shouldn't happen if isTikTokPhotoUrl gated us.
    // Bail so caller can fall through to yt-dlp.
    const err = new Error('URL is not a TikTok photo post (no imagePost.images)');
    err.code = 'NOT_A_PHOTO_POST';
    throw err;
  }

  const slideThumbnails = images
    .map((img) => img?.imageURL?.urlList?.[0])
    .filter(Boolean)
    .slice(0, 10);

  const description = itemStruct.desc || itemStruct.contents?.[0]?.desc || '';
  const title =
    itemStruct.shareMeta?.title ||
    itemStruct.shareInfo?.shareTitle ||
    description.slice(0, 80) ||
    '';
  const uploader =
    itemStruct.author?.uniqueId ||
    itemStruct.author?.nickname ||
    '';
  const challengeTags = Array.isArray(itemStruct.challenges)
    ? itemStruct.challenges
        .map((c) => (c?.title || '').toLowerCase().trim())
        .filter(Boolean)
    : [];
  const captionHashtags = (description.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || []).map((t) =>
    t.slice(1).toLowerCase(),
  );
  const hashtags = [...new Set([...challengeTags, ...captionHashtags])];

  const coverUrl =
    imagePost?.cover?.imageURL?.urlList?.[0] ||
    slideThumbnails[0] ||
    '';

  return {
    title,
    description,
    thumbnail_url: coverUrl,
    uploader,
    hashtags,
    webpage_url: finalUrl || url,
    location: null,
    is_carousel: images.length > 1,
    slide_count: images.length,
    slide_thumbnails: slideThumbnails,
    subtitles: null,
  };
}

module.exports = { fetchTikTokPhotoPost, isTikTokPhotoUrl };
