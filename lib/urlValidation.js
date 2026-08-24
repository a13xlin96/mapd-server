// /extract (and yt-dlp callers generally) accept only https URLs on hosts
// the pipeline actually supports. Blocks yt-dlp option injection (leading
// dashes), non-https schemes, and SSRF to internal/metadata addresses.
//
// Host list mirrors what enrich.js / lib/urlResolve.js / enrich/ogMetadata.js
// actually route through yt-dlp or its short-URL resolver:
//   - tiktok.com   (incl. vm.tiktok.com short links)
//   - instagram.com
//   - instagr.am    (Instagram short-link host, see lib/urlResolve.js)
//   - youtube.com / youtu.be
//   - google.com / goo.gl (Google Maps links, incl. maps.app.goo.gl)
const ALLOWED_HOST_SUFFIXES = [
  'tiktok.com', 'instagram.com', 'instagr.am', 'youtube.com', 'youtu.be',
  'google.com', 'goo.gl',
];

function isAllowedExtractUrl(raw) {
  if (typeof raw !== 'string' || raw.startsWith('-')) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith('.' + s)
  );
}

module.exports = { isAllowedExtractUrl };
