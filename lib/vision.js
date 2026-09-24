const {downloadImage} = require('./thumbnails');
const {parseResponse} = require('../enrich/ai');
const {createHash} = require('crypto');
const {runSharedAiOperation} = require('./sharedAiOperation');
const VERSION = require('./engineVersion');
const jobContext = require('./jobContext');
const {EngineError,asEngineError} = require('./engineError');
const {withProvider} = require('./providerRuntime');
// Shared Claude Haiku vision extraction for carousel slide images.
// Used by both the /ai/vision-extract HTTP endpoint and the /enrich
// server-driven pipeline so they can't drift apart again.

const { anthropic } = require('./anthropic');

// Up to 20 slides — matches Instagram carousel max and aligns with the
// TikTok/yt-dlp upstream caps.
const SLIDE_CAP = 20;

function buildPrompt({ caption, hashtags, subtitles }) {
  const captionLine = caption
    ? `Caption: "${String(caption)}"`
    : 'Caption: (none)';
  const hashtagLine = Array.isArray(hashtags) && hashtags.length
    ? `Hashtags: ${hashtags.slice(0, 20).map((h) => '#' + h).join(' ')}`
    : 'Hashtags: (none)';
  const subtitleLine = subtitles
    ? `Transcript: "${String(subtitles)}"`
    : 'Transcript: (none)';
  return [
    'These are slides from a social media carousel post. Text context from the post is below; use it together with the images.',
    '',
    captionLine,
    hashtagLine,
    subtitleLine,
    '',
    'Read any place names, restaurant names, bar names, cafe names, or specific venues that appear as text overlays on the images OR are clearly referenced by the caption / hashtags / transcript. Use the text context to disambiguate overlays (e.g. "JUNO" plus coffee cues = Juno Cafe).',
    '',
    'For EACH place, also identify its city/region/country from any signal available:',
    '- Hashtags like #bali, #canggu, #nyc, #tokyo',
    '- Location names in the caption or transcript',
    '- Location text overlaid on the images',
    'This disambiguates common chain names (e.g. "Mason" alone matches a US chain but "Mason Bali" finds the actual venue). If truly no location context is present, use "" for location.',
    '',
    'Do NOT return bare city, country, or region names ("Tokyo", "Italy", "NYC") as their own entries — only specific venues.',
    'Ignore navigational text ("SWIPE", arrows), user handles that are not clearly venue accounts, and generic hashtags.',
    '',
    'Return ONLY valid JSON:',
    '{"places": [{"name": "Venue Name", "location": "City or Region, Country"}, ...]}',
    'or {"places": []} if no specific venues are visible.',
  ].join('\n');
}

// Normalize a single AI place item into {name, location} with string fields
// defensively coerced. Old-format "PlaceName" strings accepted for back-compat.
function normalizePlaceItem(item) {
  if (typeof item === 'string') {
    return { name: item.trim(), location: '' };
  }
  if (item && typeof item === 'object') {
    return {
      name: String(item.name || '').trim(),
      location: String(item.location || item.city || item.region || '').trim(),
    };
  }
  return null;
}

async function extractPlacesFromSlides({ imageUrls, contentId, caption, hashtags, subtitles }, options = {}) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { places: [] };
  }

  await jobContext.assertActive();
  // Fetch images server-side and pass as base64. Anthropic respects the
  // source host's robots.txt when using url sources, and cdninstagram.com
  // disallows their crawler — so IG carousels come back 400. Fetching
  // ourselves bypasses that restriction uniformly for all sources.
  const slice = imageUrls.slice(0, SLIDE_CAP);
  if (JSON.stringify({caption,hashtags,subtitles}).length > 24000) throw new EngineError('input_too_large',{stage:'vision'});
  const fetched = new Array(slice.length).fill(null);
  let next = 0, totalBytes = 0;
  const deadline = Math.min(Date.now() + 45000, jobContext.current()?.deadline || Infinity);
  // Two downloads at a time, 20 MB total, existing carousel coverage retained.
  await Promise.all([0,1].map(async()=>{
    while(next<slice.length) {
      const index=next++;
      if(Date.now()>deadline || options.signal?.aborted || jobContext.current()?.signal?.aborted || totalBytes>=20*1024*1024) break;
      try {
        const {bytes,contentType} = await downloadImage(slice[index]);
        totalBytes+=bytes.length;
        if(totalBytes<=20*1024*1024) fetched[index]={mediaType:contentType,data:bytes.toString('base64'),digest:createHash('sha256').update(bytes).digest('hex')};
      } catch { /* retain other successfully fetched slides */ }
    }
  }));
  await jobContext.assertActive();
  if (options.signal?.aborted) throw new EngineError('attempt_stopped', {stage:'vision'});
  const imageContent = fetched.filter(Boolean).map(({ mediaType, data }) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  }));
  if (imageContent.length === 0) {
    throw new EngineError('source_unavailable',{stage:'vision'});
  }

  const promptText = buildPrompt({ caption, hashtags, subtitles });

  const validate = result => !!result && Array.isArray(result.places) && result.places.length <= 40 &&
    result.places.every(p => p && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 300 && typeof p.location === 'string' && p.location.length <= 500) &&
    result.coverage?.read === imageContent.length && result.coverage?.total === slice.length && result.coverage?.complete === fetched.every(Boolean);
  // The ordered downloaded bytes are the evidence identity. Signed CDN URLs and
  // content IDs neither establish equivalence nor enter durable records.
  const input = {prompt:promptText, images:fetched.map(p => p ? {digest:p.digest,mediaType:p.mediaType} : null)};
  return runSharedAiOperation({...options, kind:'carousel-vision', input, model:VERSION.model,
    stage:'vision', provider:'anthropic',
    promptVersion:'carousel-vision-2', schemaVersion:VERSION.schema, optionsVersion:'20-slides-20mb-2400tokens',
    validate, ttlSeconds:result => result.coverage.complete && result.places.length ? 86400 : 300}, async () => {
  try {
    const message = await withProvider('anthropic',()=>anthropic.messages.create({
      model: VERSION.model,
      max_tokens: 2400,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          { type: 'text', text: promptText },
        ],
      }],
    },{timeout:30000,maxRetries:0,signal:jobContext.current()?.signal}),4,{stage:'vision',rateKey:'haiku',descriptor:{
      model:VERSION.model, maxInputTokens:Buffer.byteLength(promptText,'utf8') + 1024 + imageContent.length * 128,
      // Deliberately loose: a full model context allowance for EACH image.
      // This is observation only; reported usage settles the actual amount.
      maxImageTokens:imageContent.length * 200000, maxOutputTokens:2400, cacheEnabled:false,
    }});

    const parsed = parseResponse(message);
    if(!parsed || !Array.isArray(parsed.places) || parsed.places.length > 40 || !parsed.places.every(p=>typeof p==='string' || (p && typeof p.name==='string' && ['location','city','region'].every(k=>p[k]==null || typeof p[k]==='string')))) throw new EngineError('invalid_response',{stage:'vision',provider:'anthropic'});
    const rawPlaces = Array.isArray(parsed?.places) ? parsed.places : [];
    const places = rawPlaces.map(normalizePlaceItem);
    if(!places.length && !fetched.every(Boolean)) throw new EngineError('source_unavailable',{stage:'vision'});
    const result = { places,coverage:{read:imageContent.length,total:slice.length,complete:fetched.every(Boolean)} };
    if (!validate(result)) throw new EngineError('invalid_response', {stage:'vision',provider:'anthropic'});
    return result;
  } catch (error) {
    throw asEngineError(error,{stage:'vision',provider:'anthropic'});
  }
  });
}

module.exports = { extractPlacesFromSlides };
