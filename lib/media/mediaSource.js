'use strict';
const {EngineError} = require('../engineError');
const {isAllowedExtractUrl} = require('../urlValidation');
const {extractContentId} = require('../../enrich/urlUtils');
const {classifyContentProvider} = require('../contentProvider');
const {validateMediaConfig} = require('./mediaConfig');

const INTERNAL = Symbol('server-discovered-media');
const blocked = error => ['rate_limited','access_blocked','attempt_stopped','dependency_timeout'].includes(error?.code)
  || [401,403,429].includes(Number(error?.status || error?.response?.status));
// A URL/container (or absent codec field) is not evidence of an audio track.
const audioRank = value => value === true ? 2 : value === false ? 0 : 1;
const dimension = value => Number.isFinite(value) && value > 0 ? value : null;
const heightDistance = value => value === null ? Infinity : Math.abs(value - 720);
function codecPresence(value) {
  if (typeof value !== 'string' || !value.trim() || /^(?:unknown|n\/a|\?)$/i.test(value.trim())) return null;
  return value.trim().toLowerCase() !== 'none';
}
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
  const candidates = isLive || isCarousel ? [] : renditions.slice(0,100).flatMap(item => {
    const source = safeRendition(item?.url);
    if (!source || !['mp4','webm'].includes(item.format) || item.hasVideo === false || item.protocol && !['https','http'].includes(item.protocol)) return [];
    return [{url:source,format:item.format,hasAudio:typeof item.hasAudio === 'boolean' ? item.hasAudio : null,
      width:dimension(item.width),height:dimension(item.height)}];
  });
  // Top-level yt-dlp metadata can duplicate a format URL without its codec.
  // Do not let that unknown duplicate outrank explicit evidence of no audio.
  const unique=new Map();
  for (const candidate of candidates) {
    const previous=unique.get(candidate.url);
    if (!previous) unique.set(candidate.url,candidate);
    else {
      previous.hasAudio=previous.hasAudio === false || candidate.hasAudio === false ? false
        : previous.hasAudio ?? candidate.hasAudio;
      previous.width ??= candidate.width;previous.height ??= candidate.height;
    }
  }
  const sources=[...unique.values()].sort((a,b) => audioRank(b.hasAudio)-audioRank(a.hasAudio)
    || heightDistance(a.height)-heightDistance(b.height)).slice(0,4);
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
  const descriptor=createMediaDescriptor({url,durationMs:metadata.duration * 1000,isLive:metadata.is_live === true,
    isCarousel:Array.isArray(metadata.entries) && metadata.entries.length > 1,
    renditions:[metadata,...formats].filter(f => f && typeof f === 'object').map(f => {
      const audio=codecPresence(f.acodec),video=codecPresence(f.vcodec);
      // Known audio without any video evidence must not become a muxed pick.
      const hasVideo=video ?? (dimension(f.width) && dimension(f.height) ? true : audio === true ? false : null);
      return {url:f.url,format:f.ext,protocol:f.protocol,hasAudio:audio,hasVideo,width:f.width,height:f.height};
    })});
  // Only the SAME explicitly identified yt-dlp post may donate separate audio.
  // No HTML music URL, client descriptor, playlist, fragments or second reader.
  if (descriptor?.availability === 'available' && expected && returned === expected) {
    const audio=formats.slice(0,100).find(f => f && codecPresence(f.vcodec) === false
      && typeof f.acodec === 'string' && /^(?:aac|mp4a(?:\.[a-z0-9]+)*)$/i.test(f.acodec)
      && ['m4a','mp4'].includes(f.ext) && f.protocol === 'https'
      && !f.fragments && !f.manifest_url && !f.has_drm && safeRendition(f.url)
      && !descriptor.renditions.some(r=>r.url === safeRendition(f.url)));
    if (audio) Object.defineProperty(descriptor,'audioRendition',{value:Object.freeze({
      url:safeRendition(audio.url),format:audio.ext,contentId:expected,
    }),enumerable:false});
  }
  return descriptor;
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
  const expected=extractContentId(url),provider=classifyContentProvider(url);
  const matches = descriptor => descriptor?.[INTERNAL] && descriptor.provider === provider
    && (expected ? descriptor.contentId === expected : descriptor.sourceUrl === url);
  const candidate = extracted?.mediaDescriptor;
  const direct = matches(candidate) ? candidate : null;
  // HTML can supply a useful caption without a direct video URL. That is not
  // a completed video discovery; keep fresh and serialized-cache reads equal.
  // Known live/carousel exclusions remain terminal and never trigger a reader.
  if (direct && ['live_unsupported','not_video'].includes(direct.reason)) return direct;
  if (extracted?.is_carousel || extracted?.mediaDiscoveryAttempted && !extracted?.mediaAvailable) return createMediaDescriptor({url,isCarousel:extracted?.is_carousel});
  // HTML audio declarations can be unknown/absent even when another direct
  // muxed rendition exists. Discover once BEFORE the sole download. A fresh
  // yt-dlp result already did this work; a serialized result still needs its
  // non-enumerable descriptor rediscovered, as before.
  if (direct?.availability === 'available' && (provider !== 'instagram'
      || direct.renditions[0].hasAudio === true || extracted?.mediaDiscoveryAttempted)) return direct;
  const run = deps.runYtDlp || require('../ytdlp').runYtDlp;
  const withProvider = deps.withProvider || require('../providerRuntime').withProvider;
  // withProvider retains existing fleet cooldowns. A 429 propagates: there is no alternative reader.
  const discoveryDeadline=Math.min(deadline || Infinity,Date.now()+policy.requestTimeoutMs);
  const data = await withProvider(classifyContentProvider(url),() => run(url,{signal,
    deadline:discoveryDeadline,mediaOnly:true}));
  if (signal?.aborted) throw new EngineError('attempt_stopped',{stage:'media_source'});
  if (Date.now() >= discoveryDeadline) throw new EngineError('dependency_timeout',{stage:'media_source'});
  const discovered=data?.mediaDescriptor;
  if (discovered?.[INTERNAL] && !matches(discovered)) throw new EngineError('source_unavailable',{stage:'media_source'});
  if (matches(discovered) && (discovered.availability === 'available'
      || ['live_unsupported','not_video'].includes(discovered.reason))) return discovered;
  // Only a successful metadata read with no usable alternative may retain
  // the original same-post HTML video. Errors never reach this fallback.
  return direct || createMediaDescriptor({url});
}
function assertInternalDescriptor(descriptor) {
  if (!descriptor?.[INTERNAL] || descriptor.availability !== 'available' || !descriptor.renditions.length) {
    throw new EngineError('source_unavailable',{stage:'media_source'});
  }
  return descriptor;
}
module.exports = {createMediaDescriptor,attachMediaDescriptor,mediaFromYtDlp,discoverMediaSource,assertInternalDescriptor};
