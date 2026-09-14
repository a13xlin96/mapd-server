// Bounded HEAD resolution validates and pins public DNS at every redirect.
const axios = require('axios');
const {fetchPublic} = require('./publicFetch');
const {withProvider} = require('./providerRuntime');
async function resolveOneRedirect(url) {
  const host = new URL(url).hostname;
  const provider = host === 'instagr.am' || host.endsWith('.instagr.am') || host.endsWith('instagram.com') ? 'instagram' : 'tiktok';
  const response = await withProvider(provider,() => fetchPublic(url,axios,{method:'HEAD'}));
  return response.url;
}
function isShortSocialUrl(url) {
  try {
    const target = new URL(url);
    return target.hostname === 'instagr.am' || target.hostname === 'vm.tiktok.com'
      || target.hostname === 'vt.tiktok.com'
      || ((target.hostname === 'tiktok.com' || target.hostname.endsWith('.tiktok.com')) && target.pathname.startsWith('/t/'));
  } catch {return false;}
}
module.exports = {resolveOneRedirect,isShortSocialUrl};
