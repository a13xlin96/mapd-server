// Routing identity only: network requests must still validate DNS/redirects.
const PROVIDER_HOSTS = new Map([
  ...['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am'].map(host => [host, 'instagram']),
  ...['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].map(host => [host, 'tiktok']),
  ...['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].map(host => [host, 'youtube']),
]);

function parseProviderUrl(raw) {
  if (typeof raw !== 'string' || raw !== raw.trim() || /[\\\x00-\x20\x7f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    return url;
  } catch { return null; }
}

function classifyContentProvider(raw) {
  const url = parseProviderUrl(raw);
  if (!url) return null;
  if (/^\/(?:redirect|attribution_link)(?:\/|$)/.test(url.pathname)) return null;
  return PROVIDER_HOSTS.get(url.hostname) || null;
}

function isYouTubeVideoUrl(raw) {
  if (classifyContentProvider(raw) !== 'youtube') return false;
  const url = new URL(raw);
  if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') return /^\/[\w-]+\/?$/.test(url.pathname);
  if (url.pathname === '/watch') return /^[\w-]+$/.test(url.searchParams.get('v') || '');
  return /^\/(?:shorts|embed|live)\/[\w-]+\/?$/.test(url.pathname);
}

module.exports = { classifyContentProvider, isYouTubeVideoUrl };
