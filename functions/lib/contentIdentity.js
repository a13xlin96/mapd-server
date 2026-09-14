const { createHash } = require('crypto');

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/');

// Parse the host first: a social URL in a query string or lookalike hostname
// cannot claim another post's identity. This module is shared with Functions.
function contentIdFor(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id;
    if (['instagram.com', 'm.instagram.com'].includes(host)) {
      id = url.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
      return id && id.length <= 100 ? `instagram:${id}` : null;
    }
    if (['tiktok.com', 'm.tiktok.com'].includes(host)) {
      id = url.pathname.match(/\/(?:video|photo)\/(\d+)(?:\/|$)/)?.[1];
      return id && id.length <= 100 ? `tiktok:${id}` : null;
    }
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      id = host === 'youtu.be' ? url.pathname.split('/')[1]
        : url.pathname === '/watch' ? url.searchParams.get('v')
          : url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
      return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? `youtube:${id}` : null;
    }
  } catch { /* A malformed source is not an identity. */ }
  return null;
}

function sourceKey(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const content = contentIdFor(value);
  if (content) return content;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|igsh|igshid$|stkn$|fbclid$|share_id$)/.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `url:${hash(url.toString())}`;
  } catch { return null; }
}

function identities(pin) {
  const values = [pin?.url, ...(Array.isArray(pin?.sources) ? pin.sources.map(s => s?.url) : [])];
  return [...new Set(values.map(sourceKey).filter(Boolean))].sort();
}

function indexRows(uid, pinId, keys) {
  const rows = [];
  // Chunking avoids a single document/index-entry limit for imported pins
// with many sources. The pin document itself bounds total input size.
  for (let offset = 0; offset < keys.length; offset += 500) {
    rows.push({ id: hash(`${uid}\0${pinId}\0${offset / 500}`), userId: uid, pinId,
      contentIds: keys.slice(offset, offset + 500), schemaVersion: 1 });
  }
  return rows;
}

module.exports = { hash, validId, contentIdFor, sourceKey, identities, indexRows };
