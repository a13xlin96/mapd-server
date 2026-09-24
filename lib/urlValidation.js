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
//
// Google and YouTube redirector routes are excluded below. Generic metadata
// fetching separately validates every DNS answer and redirect destination.
const ALLOWED_HOST_SUFFIXES = [
  'tiktok.com', 'instagram.com', 'instagr.am', 'youtube.com', 'youtu.be',
  'google.com', 'goo.gl',
];

function isAllowedExtractUrl(raw) {
  // The leading-dash check is redundant with the parse/protocol checks below
  // (new URL('-foo') either throws or never resolves to an allowed https
  // host) but is kept explicit so option-injection intent ('-x', '--flag')
  // is rejected up front and can't be reintroduced by future edits to the
  // parsing logic below.
  if (typeof raw !== 'string' || raw.startsWith('-')) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  // .toLowerCase() is redundant given URL() already lowercases hostnames,
  // but kept explicit so this comparison stays correct even if that
  // normalization behavior ever changes.
  const host = u.hostname.toLowerCase();
  if (host === 'google.com' || host.endsWith('.google.com')) return /^\/maps(?:\/|$)/.test(u.pathname);
  if (host === 'goo.gl') return /^\/maps\//.test(u.pathname);
  if (host.endsWith('.goo.gl')) return host === 'maps.app.goo.gl';
  if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && /^\/(?:redirect|attribution_link)(?:\/|$)/.test(u.pathname)) return false;
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith('.' + s)
  );
}

module.exports = { isAllowedExtractUrl };
