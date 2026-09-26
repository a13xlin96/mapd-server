'use strict';
const {EngineError} = require('../engineError');
const {isAllowedExtractUrl} = require('../urlValidation');
const {extractContentId} = require('../../enrich/urlUtils');
const {classifyContentProvider} = require('../contentProvider');
const {validateMediaConfig} = require('./mediaConfig');

const INTERNAL = Symbol('server-discovered-media');
const blocked = error => ['rate_limited','access_blocked','attempt_stopped','dependency_timeout'].includes(error?.code)
  || [401,403,429].includes(Number(error?.status || error?.response?.status));
function safeRendition(url) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && !value.username && !value.password && (!value.port || value.port === '443')
      && !/\.(?:m3u8|mpd)(?:$|[?#])/i.test(value.href) && value.href.length <= 8192 ? value.href : null;
  } catch { return null; }
}

/** Internal descriptor factory. Input MUST be a matching server-read post, never request JSON.
 * URLs stay in a non-enumerable property: JSON caches/jobs/compatibility responses cannot leak them.
 * DNS is revalidated and pinned at download time, not trusted from this syntactic validation.
 */
function createMediaDescriptor({url, renditions = [], durationMs = null, isLive = false, isCarousel = false}) {
  if (!isAllowedExtractUrl(url) || !classifyContentProvider(url)) return null;
  const sources = isLive || isCarousel ? [] : renditions.slice(0,100).flatMap(item => {
    const source = safeRendition(item?.url);
    if (!source || !['mp4','webm'].includes(item.format) || item.hasVideo === false || item.protocol && !['https','http'].includes(item.protocol)) return [];
    return [{url:source,format:item.format,hasAudio:item.hasAudio !== false,
      width:Number.isFinite(item.width) ? item.width : null,height:Number.isFinite(item.height) ? item.height : null}];
  }).sort((a,b) => Number(b.hasAudio)-Number(a.hasAudio)
    || Math.abs((a.height || 720)-720)-Math.abs((b.height || 720)-720)).slice(0,4);
  const descriptor = {sourceUrl:url,contentId:extractContentId(url),provider:classifyContentProvider(url),
    durationMs:Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
    availability:sources.length ? 'available' : 'unavailable', reason:isLive ? 'live_unsupported' : isCarousel ? 'not_video' : sources.length ? null : 'direct_media_unavailable',renditions:sources};
  Object.defineProperty(descriptor,INTERNAL,{value:true});
  return descriptor;
}
function attachMediaDescriptor(data, descriptor) {
  if (descriptor) {
    Object.defineProperty(data,'mediaDescriptor',{value:descriptor,enumerable:false,configurable:true});
    data.mediaAvailable = descriptor.availability === 'available';
  }
  return data;
}
function mediaFromYtDlp(metadata, url) {
  const expected=extractContentId(url),returned=extractContentId(metadata.webpage_url || '');
  if (expected && returned && expected !== returned) return createMediaDescriptor({url});
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  return createMediaDescriptor({url,durationMs:metadata.duration * 1000,isLive:metadata.is_live === true,
    isCarousel:Array.isArray(metadata.entries) && metadata.entries.length > 1,
    renditions:[metadata,...formats].map(f => ({url:f.url,format:f.ext,protocol:f.protocol,
      hasAudio:f.acodec !== 'none',hasVideo:f.vcodec !== 'none',width:f.width,height:f.height}))});
}

/** One on-demand metadata discovery, never a download retry. Caller supplies active attempt context.
 * Returns an internal descriptor; unavailable media is distinct from an empty transcript.
 */
async function discoverMediaSource({url,extracted,signal,deadline,config = {},sourceFailure}, deps = {}) {
  const policy = validateMediaConfig(config);
  if (signal?.aborted) throw new EngineError('attempt_stopped',{stage:'media_source'});
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw new EngineError('dependency_timeout',{stage:'media_source'});
  if (blocked(sourceFailure)) throw sourceFailure;
  if (!isAllowedExtractUrl(url) || !classifyContentProvider(url)) throw new EngineError('access_blocked',{stage:'media_source'});
  const candidate = extracted?.mediaDescriptor;
  const direct = candidate?.[INTERNAL] && candidate.contentId === extractContentId(url) ? candidate : null;
  // HTML can supply a useful caption without a direct video URL. That is not
  // a completed video discovery; keep fresh and serialized-cache reads equal.
  // Known live/carousel exclusions remain terminal and never trigger a reader.
  if (direct && (direct.availability === 'available' || ['live_unsupported','not_video'].includes(direct.reason))) return direct;
  if (extracted?.is_carousel || extracted?.mediaDiscoveryAttempted && !extracted?.mediaAvailable) return createMediaDescriptor({url,isCarousel:extracted?.is_carousel});
  const run = deps.runYtDlp || require('../ytdlp').runYtDlp;
  const withProvider = deps.withProvider || require('../providerRuntime').withProvider;
  // withProvider retains existing fleet cooldowns. A 429 propagates: there is no alternative reader.
  const data = await withProvider(classifyContentProvider(url),() => run(url,{signal,
    deadline:Math.min(deadline || Infinity,Date.now()+policy.requestTimeoutMs),mediaOnly:true}));
  if (signal?.aborted) throw new EngineError('attempt_stopped',{stage:'media_source'});
  return data?.mediaDescriptor?.[INTERNAL] ? data.mediaDescriptor : createMediaDescriptor({url});
}
function assertInternalDescriptor(descriptor) {
  if (!descriptor?.[INTERNAL] || descriptor.availability !== 'available' || !descriptor.renditions.length) {
    throw new EngineError('source_unavailable',{stage:'media_source'});
  }
  return descriptor;
}
module.exports = {createMediaDescriptor,attachMediaDescriptor,mediaFromYtDlp,discoverMediaSource,assertInternalDescriptor};
