// Public source extraction shared by the worker and compatibility endpoint.
const {createHash} = require('crypto');
const {getCached,setCache,normalizeUrlForCache} = require('./cache');
const {extractContentId} = require('../enrich/urlUtils');
const {runYtDlp} = require('./ytdlp');
const {fetchInstagramReelPost,isInstagramReelUrl} = require('./instagramReel');
const {fetchInstagramCarouselPost,isInstagramPostUrl} = require('./instagramCarousel');
const {fetchTikTokPhotoPost,isTikTokPhotoUrl} = require('./tiktokPhoto');
const {isShortSocialUrl,resolveOneRedirect} = require('./urlResolve');
const {isAllowedExtractUrl} = require('./urlValidation');
const {asEngineError,EngineError} = require('./engineError');
const {withLease,withProvider} = require('./providerRuntime');
const VERSION = require('./engineVersion');
const jobContext=require('./jobContext');
const {classifyContentProvider}=require('./contentProvider');
const multilingual=()=>jobContext.current()?.features?.versions?.languageRouting==='multilingual-v1';
const inFlight = new Map(), resolving = new Map();
function extractionKey(url) {
  return 'engine:source:'+VERSION.engine+':'+(multilingual()?'native':'english')+':'+createHash('sha256').update(extractContentId(url) || normalizeUrlForCache(url)).digest('hex');
}
async function extractCanonicalPost(rawUrl) {
  if(!isAllowedExtractUrl(rawUrl)) throw new EngineError('source_unavailable',{stage:'input'});
  let url=normalizeUrlForCache(rawUrl);
  if(isShortSocialUrl(url)) {
    const resolved=await resolveOneRedirect(url);
    if(!isAllowedExtractUrl(resolved)) throw new EngineError('source_unavailable',{stage:'redirect'});
    url=normalizeUrlForCache(resolved);
  }
  const key=extractionKey(url), cached=await getCached(key);
  if(cached) return cached;
  if(inFlight.has(key)) return inFlight.get(key);
  const pending=withLease(key,async()=>{
    const again=await getCached(key); if(again) return again;
    const provider=classifyContentProvider(url);
    if(!provider) throw new EngineError('source_unavailable',{stage:'input'});
    const data=await withProvider(provider,async()=>{
      try {
        if(isTikTokPhotoUrl(url)) return await fetchTikTokPhotoPost(url);
        if(isInstagramPostUrl(url)) return await fetchInstagramCarouselPost(url);
        if(isInstagramReelUrl(url)) return await fetchInstagramReelPost(url);
        return await runYtDlp(url,{deadline:jobContext.current()?.deadline,multilingual:multilingual()});
      } catch(error) {
        const e=asEngineError(error,{stage:'source',provider});
        // A 429 or block is not a reason to hit the same provider again
        // through another reader. A genuine format mismatch may fall back.
        if(['rate_limited','access_blocked','dependency_timeout'].includes(e.code) || (!isInstagramPostUrl(url) && !isInstagramReelUrl(url))) throw e;
        return await runYtDlp(url,{deadline:jobContext.current()?.deadline,multilingual:multilingual()});
      }
    });
    const genericTitle=/^(instagram|log in.*|login.*|sign up.*)$/i.test(String(data?.title || '').trim());
    if(data && genericTitle && !data.description && !data.accountTags?.length && !data.subtitles && !data.mediaAvailable) throw new EngineError('source_unavailable',{stage:'source',provider});
    if(!data || (!data.description && !data.title && !data.subtitles && !data.accountTags?.length && !data.mediaAvailable)) throw new EngineError('source_unavailable',{stage:'source',provider});
    // A partial read remains usable now, but must not become a cached claim
    // that all available evidence was read successfully for the next attempt.
    if(!data.subtitle_failures?.length) {
      await setCache(key,data,3600);
      if(data.webpage_url && isAllowedExtractUrl(data.webpage_url)) await setCache(extractionKey(data.webpage_url),data,3600);
    }
    return data;
  });
  inFlight.set(key,pending);
  try{return await pending;}finally{inFlight.delete(key);}
}
async function extractPublicPost(rawUrl) {
  if(!isAllowedExtractUrl(rawUrl)) throw new EngineError('source_unavailable',{stage:'input'});
  const key=extractionKey(rawUrl),cached=await getCached(key);
  if(cached) return cached;
  if(resolving.has(key)) return resolving.get(key);
  const pending=extractCanonicalPost(rawUrl).then(async data=>{
    if(!data.subtitle_failures?.length) await setCache(key,data,3600);return data;
  });
  resolving.set(key,pending);
  try{return await pending;}finally{resolving.delete(key);}
}
module.exports={extractPublicPost,extractionKey};
