// One-shot HEAD-redirect resolution for social short URLs (tiktok.com/t/...,
// vm.tiktok.com, instagr.am, etc.). Used by /extract and /enrich to know the
// canonical URL before routing to the right extractor.
//
// Only follows ONE redirect because short-URL services redirect directly to
// the canonical page. For chains of redirects, yt-dlp handles its own.

function resolveOneRedirect(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (response) => {
      if (
        response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        resolve(response.headers.location);
      } else {
        resolve(url);
      }
    });
    req.on('error', () => resolve(url));
    req.on('timeout', () => { req.destroy(); resolve(url); });
    req.end();
  });
}

// Same short-URL host list used across /extract + /enrich call sites.
function isShortSocialUrl(url) {
  return !!url && (
    url.includes('/t/')
    || url.includes('vm.tiktok')
    || url.includes('instagr.am')
  );
}

module.exports = { resolveOneRedirect, isShortSocialUrl };
