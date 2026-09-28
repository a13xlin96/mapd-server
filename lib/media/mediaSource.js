'use strict';
const {EngineError} = require('../engineError');
const {isAllowedExtractUrl} = require('../urlValidation');
const {extractContentId} = require('../../enrich/urlUtils');
const {classifyContentProvider} = require('../contentProvider');
const {validateMediaConfig} = require('./mediaConfig');

const INTERNAL = Symbol('server-discovered-media');
// Private accepted inventories precede shortlist truncation. A second reader's
// fifth candidate can carry silence evidence for an HTML URL. Never serialize
// these URLs or accept inventories from request JSON / persisted descriptors.
const INVENTORIES = new WeakMap();
// Observation only. Never stored on the descriptor or accepted from callers.
// Counts inspect <=100 root formats and <=10 entries with <=100 formats each.
const DIAGNOSTICS = new WeakMap();
const AUDIO_REJECTIONS = Object.freeze(['Video','Codec','Container','Protocol','Fragments','Manifest','Drm','Url','Duplicate']);
const SELECTION_DIAGNOSTIC_OPERATIONS = Object.freeze([
  'mediaSourceUniqueAudioKnown','mediaSourceUniqueAudioUnknown','mediaSourceUniqueAudioAbsent',
  'mediaSourceChosenAudioState','mediaSourceChosenWidth','mediaSourceChosenHeight',
  'mediaSourceChosenDimensionsLimited','mediaSourceDuplicateAudioDemotions',
]);
const MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS = Object.freeze([
  'mediaSourceUnknown','mediaSourceDirect','mediaSourceYtDlp','mediaSourceFallback','mediaSourceCombined',
  'mediaSourceRootFormats','mediaSourceEntries','mediaSourceEntryFormats','mediaSourceScanTruncated',
  'mediaSourceTopAudioOnly','mediaSourceTopAudioEligible','mediaSourceRootAudioFormats','mediaSourceRootEligibleAudio',
  'mediaSourceEntryAudioFormats','mediaSourceEntryEligibleAudio',
  'mediaSourcePostBound','mediaSourcePostMissing','mediaSourcePostMismatch',
  'mediaSourceAudioEligible','mediaSourceAudioAttached',
  ...AUDIO_REJECTIONS.map(reason=>`mediaSourceAudioReject${reason}`),
  ...SELECTION_DIAGNOSTIC_OPERATIONS,
  'mediaProbeHasAudio','mediaSeparateAudioAttempted','mediaSeparateAudioProbed',
]);
const blocked = error => ['rate_limited','access_blocked','attempt_stopped','dependency_timeout'].includes(error?.code)
  || [401,403,429].includes(Number(error?.status || error?.response?.status));
// A URL/container (or absent codec field) is not evidence of an audio track.
const audioRank = value => value === true ? 2 : value === false ? 0 : 1;
const dimension = value => Number.isFinite(value) && value > 0 ? value : null;
const heightDistance = value => value === null ? Infinity : Math.abs(value - 720);
// Keep useful detail for selected frames without decoding an unknown
// or oversized source when the same post offers a proven separate audio track.
// No tiny preview/thumbnail rendition: both dimensions must support >=640px.
const knownDimensions = value => Number.isSafeInteger(value.width) && value.width>0
  && Number.isSafeInteger(value.height) && value.height>0;
const boundedVideo = value => knownDimensions(value)
  && Math.min(value.width,value.height)>=640 && Math.max(value.width,value.height)<=1280;
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
// First rejection only, identical to the acquisition predicate. No raw codec,
// ID, URL, manifest, header or provider string may become a metric label/value.
function audioRejection(format,descriptor) {
  if (!format || codecPresence(format.vcodec) !== false) return 'Video';
  if (typeof format.acodec !== 'string' || !/^(?:aac|mp4a(?:\.[a-z0-9]+)*)$/i.test(format.acodec)) return 'Codec';
  if (!['m4a','mp4'].includes(format.ext)) return 'Container';
  if (format.protocol !== 'https') return 'Protocol';
  if (format.fragments) return 'Fragments';
  if (format.manifest_url) return 'Manifest';
  if (format.has_drm) return 'Drm';
  const url=safeRendition(format.url);
  if (!url) return 'Url';
  if (descriptor?.renditions.some(r=>r.url === url)
      || INVENTORIES.get(descriptor)?.some(r=>r.url === url)) return 'Duplicate';
  return null;
}
function readMediaSourceDiagnostics(descriptor) {
  return {...DIAGNOSTICS.get(descriptor) || {mediaSourceUnknown:1}};
}
function readSelectionDiagnostics(descriptor) {
  const stats=DIAGNOSTICS.get(descriptor);
  return Object.fromEntries(SELECTION_DIAGNOSTIC_OPERATIONS.map(name=>[name,stats?.[name] ?? 0]));
}
function ytDiagnostics(metadata,expected,returned,descriptor,formats) {
  const entries=Array.isArray(metadata.entries)?metadata.entries:[];
  const bound=!!expected && returned === expected;
  const stats={...readSelectionDiagnostics(descriptor),mediaSourceYtDlp:1,mediaSourceRootFormats:Math.min(100,formats.length),
    mediaSourceEntries:Math.min(10,entries.length),mediaSourceEntryFormats:0,
    mediaSourceScanTruncated:Number(formats.length>100 || entries.length>10),
    mediaSourceTopAudioOnly:Number(codecPresence(metadata.vcodec) === false),
    mediaSourceTopAudioEligible:Number(audioRejection(metadata,descriptor) === null),
    mediaSourceRootAudioFormats:0,mediaSourceRootEligibleAudio:0,
    mediaSourceEntryAudioFormats:0,mediaSourceEntryEligibleAudio:0,
    mediaSourcePostBound:Number(bound),mediaSourcePostMissing:Number(!expected || !returned),
    mediaSourcePostMismatch:Number(!!expected && !!returned && !bound),
    mediaSourceAudioEligible:0,mediaSourceAudioAttached:Number(!!descriptor?.audioRendition)};
  for (const reason of AUDIO_REJECTIONS) stats[`mediaSourceAudioReject${reason}`]=0;
  for (const format of formats.slice(0,100)) {
    stats.mediaSourceRootAudioFormats+=Number(codecPresence(format?.vcodec) === false);
    const rejected=audioRejection(format,descriptor);
    if (rejected) stats[`mediaSourceAudioReject${rejected}`]++;
    else stats.mediaSourceRootEligibleAudio++;
  }
  for (const entry of entries.slice(0,10)) {
    const children=Array.isArray(entry?.formats)?entry.formats:[];
    stats.mediaSourceEntryFormats+=Math.min(100,children.length);
    if(children.length>100)stats.mediaSourceScanTruncated=1;
    for (const format of children.slice(0,100)) {
      stats.mediaSourceEntryAudioFormats+=Number(codecPresence(format?.vcodec) === false);
      if(audioRejection(format) === null)stats.mediaSourceEntryEligibleAudio++;
    }
  }
  // Syntactic entry/root candidates above are NOT authority to acquire them.
  // Only the existing available, root-bound descriptor can donate audio.
  if(bound && descriptor?.availability === 'available') stats.mediaSourceAudioEligible=stats.mediaSourceRootEligibleAudio;
  return Object.freeze(stats);
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
  const descriptor=descriptorFromCandidates({url,candidates,durationMs,isLive,isCarousel});
  INVENTORIES.set(descriptor,Object.freeze(candidates.map(candidate=>Object.freeze({...candidate}))));
  return descriptor;
}
// Called only with already-validated, bounded internal inventories: <=100 for
// a reader, <=200 for the one cross-reader comparison. Combined descriptors do
// not get an inventory, preventing recursive growth on a later invocation.
function descriptorFromCandidates({url,candidates,durationMs,isLive=false,isCarousel=false,preferBoundedVideo=false}) {
  // Top-level yt-dlp metadata can duplicate a format URL without its codec.
  // Do not let that unknown duplicate outrank explicit evidence of no audio.
  const unique=new Map(),demotedUrls=new Set();
  for (const candidate of candidates) {
    const previous=unique.get(candidate.url);
    if (!previous) unique.set(candidate.url,{...candidate});
    else {
      // Count unique URLs whose unknown/known audio claim loses to explicit
      // absence, independent of duplicate order. Observe only; merge unchanged.
      if ((previous.hasAudio === false && candidate.hasAudio !== false)
          || (candidate.hasAudio === false && previous.hasAudio !== false)) demotedUrls.add(candidate.url);
      previous.hasAudio=previous.hasAudio === false || candidate.hasAudio === false ? false
        : previous.hasAudio ?? candidate.hasAudio;
      previous.width ??= candidate.width;previous.height ??= candidate.height;
    }
  }
  const ranked=[...unique.values()].sort((a,b) => audioRank(b.hasAudio)-audioRank(a.hasAudio)
    || heightDistance(a.height)-heightDistance(b.height));
  // Proven muxed audio always retains precedence. Only the same-post yt-dlp
  // path can enable this, after validating a separate progressive AAC source.
  // Preserve a bounded existing pick; otherwise prefer the largest bounded
  // rendition, including candidates outside the former four-item shortlist.
  const current=ranked[0] || {},known=knownDimensions(current);
  if(preferBoundedVideo && current.hasAudio!==true && (!known || Math.max(current.width,current.height)>1280)) {
    const best=ranked.filter(r=>boundedVideo(r) && (!known || r.width*r.height<current.width*current.height))
      .sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    if(best) {ranked.splice(ranked.indexOf(best),1);ranked.unshift(best);}
  }
  const sources=ranked.slice(0,4);
  const descriptor = {sourceUrl:url,contentId:extractContentId(url),provider:classifyContentProvider(url),
    durationMs:Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
    availability:sources.length ? 'available' : 'unavailable', reason:isLive ? 'live_unsupported' : isCarousel ? 'not_video' : sources.length ? null : 'direct_media_unavailable',renditions:sources};
  Object.defineProperty(descriptor,INTERNAL,{value:true});
  // Accepted unique candidates BEFORE the four-rendition shortlist. Counters
  // are <=200 across both readers. Chosen state: 0=none, 1=absent, 2=unknown, 3=known. Dimensions
  // are telemetry-only integers, 0=unknown, capped at 16384 with a limit flag;
  // never replace the original dimensions used by selection/probing.
  const chosen=sources[0],boundedDimension=value=>Math.min(16384,Math.floor(value ?? 0));
  const width=boundedDimension(chosen?.width),height=boundedDimension(chosen?.height);
  DIAGNOSTICS.set(descriptor,Object.freeze({mediaSourceDirect:1,
    mediaSourceUniqueAudioKnown:[...unique.values()].filter(r=>r.hasAudio === true).length,
    mediaSourceUniqueAudioUnknown:[...unique.values()].filter(r=>r.hasAudio === null).length,
    mediaSourceUniqueAudioAbsent:[...unique.values()].filter(r=>r.hasAudio === false).length,
    mediaSourceChosenAudioState:chosen?audioRank(chosen.hasAudio)+1:0,
    mediaSourceChosenWidth:width,mediaSourceChosenHeight:height,
    mediaSourceChosenDimensionsLimited:Number(width !== (chosen?.width ?? 0) || height !== (chosen?.height ?? 0)),
    mediaSourceDuplicateAudioDemotions:demotedUrls.size}));
  return descriptor;
}
function retainPossibleHtmlAudio(direct,discovered) {
  const stats=readMediaSourceDiagnostics(discovered);
  const htmlInventory=INVENTORIES.get(direct),ytInventory=INVENTORIES.get(discovered);
  // Only a successful, explicitly same-post reader with exclusively silent
  // video and no usable separate audio needs this comparison. Proven muxed or
  // separate audio and unknown yt-dlp results keep their existing selection.
  if (direct?.availability !== 'available' || !htmlInventory || !ytInventory
      || stats.mediaSourcePostBound !== 1 || discovered.audioRendition
      || stats.mediaSourceUniqueAudioKnown || stats.mediaSourceUniqueAudioUnknown) return discovered;
  const combined=descriptorFromCandidates({url:discovered.sourceUrl,
    candidates:[...ytInventory,...htmlInventory],durationMs:discovered.durationMs ?? direct.durationMs});
  // Explicit absence wins duplicate conflicts, including evidence outside the
  // four-rendition shortlist. If no possible audio remains, keep the old pick.
  if (combined.renditions[0]?.hasAudio !== null) return discovered;
  DIAGNOSTICS.set(combined,Object.freeze({...stats,...readSelectionDiagnostics(combined),
    mediaSourceDirect:1,mediaSourceCombined:1,mediaSourceAudioAttached:0}));
  return combined;
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
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  let descriptor=expected && returned && expected !== returned ? createMediaDescriptor({url})
    : createMediaDescriptor({url,durationMs:metadata.duration * 1000,isLive:metadata.is_live === true,
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
    const inventory=INVENTORIES.get(descriptor);
    const audio=formats.slice(0,100).find(f => audioRejection(f,descriptor) === null);
    if (audio) {
      // Instagram may omit metadata duration even for bounded renditions.
      // The decoder, not this optional declaration, enforces actual length
      // and verifies both tracks' durations/origins before consuming audio.
      if(inventory) {
        descriptor=descriptorFromCandidates({url,candidates:inventory,durationMs:descriptor.durationMs,preferBoundedVideo:true});
        INVENTORIES.set(descriptor,inventory);
      }
      Object.defineProperty(descriptor,'audioRendition',{value:Object.freeze({
        url:safeRendition(audio.url),format:audio.ext,contentId:expected,
      }),enumerable:false});
    }
  }
  if (descriptor) DIAGNOSTICS.set(descriptor,ytDiagnostics(metadata,expected,returned,descriptor,formats));
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
  if (extracted?.is_carousel || extracted?.mediaDiscoveryAttempted && !extracted?.mediaAvailable) return direct?.availability === 'unavailable'
    ? direct : createMediaDescriptor({url,isCarousel:extracted?.is_carousel});
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
  if (matches(discovered) && ['live_unsupported','not_video'].includes(discovered.reason)) return discovered;
  if (matches(discovered) && discovered.availability === 'available') {
    return provider === 'instagram' ? retainPossibleHtmlAudio(direct,discovered) : discovered;
  }
  // Only a successful metadata read with no usable alternative may retain
  // the original same-post HTML video. Errors never reach this fallback.
  if (direct) DIAGNOSTICS.set(direct,Object.freeze({...readMediaSourceDiagnostics(discovered),
    ...readSelectionDiagnostics(direct),
    mediaSourceDirect:1,mediaSourceFallback:1,mediaSourceAudioAttached:Number(!!direct.audioRendition)}));
  return direct || (matches(discovered)?discovered:createMediaDescriptor({url}));
}
function assertInternalDescriptor(descriptor) {
  if (!descriptor?.[INTERNAL] || descriptor.availability !== 'available' || !descriptor.renditions.length) {
    throw new EngineError('source_unavailable',{stage:'media_source'});
  }
  return descriptor;
}
module.exports = {createMediaDescriptor,attachMediaDescriptor,mediaFromYtDlp,discoverMediaSource,assertInternalDescriptor,
  readMediaSourceDiagnostics,MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS};
