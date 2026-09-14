function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.replace('www.', '').split('.');
    return parts[0] || hostname;
  } catch {
    return 'unknown';
  }
}

function determineSourceApp(url) {
  const provider = require('../lib/contentProvider').classifyContentProvider(url);
  if (provider) return provider;
  const domain = extractDomain(url).toLowerCase();
  const knownApps = {
    tiktok: 'tiktok',
    instagram: 'instagram',
    youtube: 'youtube',
    youtu: 'youtube',
    twitter: 'twitter',
    x: 'twitter',
    facebook: 'facebook',
    reddit: 'reddit',
    tripadvisor: 'tripadvisor',
    yelp: 'yelp',
    google: 'google',
  };
  return knownApps[domain] || 'other';
}

const { contentIdFor: extractContentId } = require('../functions/lib/contentIdentity');

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const trackingParams = ['igsh', 'igshid', 'ig_rid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', '_r', '_t', '_d', '_svg', 'g_st', 'g_ep', 'entry', 'coh', 'skid', 'img_index', 'fbclid', 'ref', 'share_id'];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    let normalized = parsed.origin.replace('www.', '') + parsed.pathname.replace(/\/+$/, '');
    const remaining = parsed.searchParams.toString();
    if (remaining) normalized += '?' + remaining;
    return normalized;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

module.exports = { extractDomain, determineSourceApp, extractContentId, normalizeUrl };
