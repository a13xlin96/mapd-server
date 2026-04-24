const { admin, firestore } = require('./lib/firestore');
const { runYtDlp } = require('./lib/ytdlp');
const { fetchTikTokPhotoPost, isTikTokPhotoUrl } = require('./lib/tiktokPhoto');
const { fetchInstagramCarouselPost, isInstagramPostUrl } = require('./lib/instagramCarousel');
const { extractPlacesFromSlides } = require('./lib/vision');
const { normalizePlaceName, dedupe, parseMentionedAccounts } = require('./lib/placeNameNormalize');
const { resolveOneRedirect, isShortSocialUrl } = require('./lib/urlResolve');
const { decodeHtmlEntities, cleanSocialText } = require('./enrich/utils');
const { extractDomain, determineSourceApp, extractContentId, normalizeUrl } = require('./enrich/urlUtils');
const {
  fetchOGMetadata,
  resolveShortUrl,
  isGoogleMapsUrl,
  parseGoogleMapsUrl,
} = require('./enrich/ogMetadata');
const {
  extractLocationQuery,
  extractLocationFromComponents,
  extractLocation,
  extractPinMarker,
} = require('./enrich/locationParser');
const { calculateConfidence } = require('./enrich/confidence');
const { mapToCategory } = require('./enrich/categories');
const { searchGooglePlaces, getPlaceDetails, findPlaceFromUrl } = require('./enrich/places');
const { aiExtractPlaces, aiExtractPlace, aiVerifyPlace } = require('./enrich/ai');
const { sendPushForJob } = require('./lib/push');

const ts = () => (admin && admin.firestore && admin.firestore.FieldValue.serverTimestamp());

async function setJob(jobId, data) {
  if (!firestore) return;
  await firestore.collection('enrichmentJobs').doc(jobId).set(data, { merge: true });
}

async function updateJob(jobId, data) {
  if (!firestore) return;
  await firestore.collection('enrichmentJobs').doc(jobId).set({ ...data, updatedAt: ts() }, { merge: true });
}

async function findPinByUrl(userId, url) {
  if (!firestore) return null;
  const normalized = normalizeUrl(url);
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('url', '==', url)
    .limit(1)
    .get();
  if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };

  const byNormalized = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('url', '==', normalized)
    .limit(1)
    .get();
  if (!byNormalized.empty) return { id: byNormalized.docs[0].id, ...byNormalized.docs[0].data() };
  return null;
}

async function findPinByContentId(userId, contentId) {
  if (!firestore || !contentId) return null;
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const pinUrl = data.url;
    if (!pinUrl) continue;
    if (extractContentId(pinUrl) === contentId) {
      return { id: doc.id, ...data };
    }
  }
  return null;
}

async function findPinByPlaceId(userId, placeId) {
  if (!firestore || !placeId) return null;
  const snap = await firestore.collection('pins')
    .where('userId', '==', userId)
    .where('placeId', '==', placeId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

function buildPinFromDetails({ url, userId, ogData, details, topResult, category, location, confidenceScore }) {
  const sourceDomain = extractDomain(url);
  const sourceApp = determineSourceApp(url);
  const lat = details ? details.geometry.location.lat : (topResult && topResult.geometry.location.lat) || null;
  const lng = details ? details.geometry.location.lng : (topResult && topResult.geometry.location.lng) || null;

  return {
    userId,
    url,
    sourceApp,
    sourceDomain,
    ogTitle: decodeHtmlEntities((ogData && ogData.title) || ''),
    ogDescription: decodeHtmlEntities((ogData && ogData.description) || ''),
    ogImage: (ogData && ogData.image) || '',
    placeId: (details && topResult && topResult.place_id) || (topResult && topResult.place_id) || null,
    placeName: (details && details.name) || (topResult && topResult.name) || '',
    formattedAddress: (details && details.formatted_address) || (topResult && topResult.formatted_address) || '',
    latitude: lat,
    longitude: lng,
    category,
    rating: (details && details.rating) || (topResult && topResult.rating) || null,
    userRatingsTotal: (details && details.user_ratings_total) || (topResult && topResult.user_ratings_total) || null,
    priceLevel: (details && details.price_level) || null,
    shortFormattedAddress: (details && details.short_formatted_address) || null,
    primaryType: (details && details.primary_type) || null,
    dineIn: details ? details.dine_in : null,
    takeout: details ? details.takeout : null,
    delivery: details ? details.delivery : null,
    reservable: details ? details.reservable : null,
    openingPeriods: (details && details.opening_periods) || null,
    weekdayDescriptions: (details && details.weekday_descriptions) || null,
    utcOffsetMinutes: details && typeof details.utc_offset_minutes === 'number' ? details.utc_offset_minutes : null,
    website: (details && details.website) || null,
    phoneNumber: (details && details.formatted_phone_number) || null,
    status: 'pinned',
    confidenceScore: confidenceScore == null ? 85 : confidenceScore,
    listIds: [],
    country: (location && location.country) || null,
    region: (location && location.region) || null,
    city: (location && location.city) || null,
    visited: false,
    wouldGoBack: null,
    visitedAt: null,
    visitNote: null,
    serverEnriched: true,
  };
}

// Transactional pin write — re-checks placeId, raw URL, and normalized URL
// dedup INSIDE the txn so two concurrent jobs (different jobIds, same place)
// can't both pass the pre-AI dedup check and write two pins. Mirrors the
// fallback list of findPinByUrl (raw → normalized) for symmetry.
// Returns { pinId, alreadyExists }. Caller must surface 'duplicate' status
// when alreadyExists is true.
async function writePinTransactional(pin, _ogData) {
  if (!firestore) return null;
  const source = {
    url: pin.url,
    ogTitle: pin.ogTitle,
    ogImage: pin.ogImage,
    sourceApp: pin.sourceApp,
    sourceDomain: pin.sourceDomain,
    addedAt: new Date(),
  };
  const normalizedUrl = normalizeUrl(pin.url);
  return await firestore.runTransaction(async (txn) => {
    if (pin.placeId) {
      const placeSnap = await txn.get(
        firestore.collection('pins')
          .where('userId', '==', pin.userId)
          .where('placeId', '==', pin.placeId)
          .limit(1)
      );
      if (!placeSnap.empty) {
        return { pinId: placeSnap.docs[0].id, alreadyExists: true };
      }
    }
    const rawUrlSnap = await txn.get(
      firestore.collection('pins')
        .where('userId', '==', pin.userId)
        .where('url', '==', pin.url)
        .limit(1)
    );
    if (!rawUrlSnap.empty) {
      return { pinId: rawUrlSnap.docs[0].id, alreadyExists: true };
    }
    if (normalizedUrl !== pin.url) {
      const normSnap = await txn.get(
        firestore.collection('pins')
          .where('userId', '==', pin.userId)
          .where('url', '==', normalizedUrl)
          .limit(1)
      );
      if (!normSnap.empty) {
        return { pinId: normSnap.docs[0].id, alreadyExists: true };
      }
    }
    const ref = firestore.collection('pins').doc();
    txn.set(ref, { ...pin, sources: [source], createdAt: ts(), updatedAt: ts() });
    return { pinId: ref.id, alreadyExists: false };
  });
}

/** Google Maps URL: parse → Places search → single pin. */
async function handleGoogleMapsUrl(url, userId) {
  let resolved = url;
  if (url.includes('goo.gl') || url.includes('maps.app')) {
    resolved = await resolveShortUrl(url);
  }
  const parsed = parseGoogleMapsUrl(resolved);
  if (!parsed) return null;

  let top = await findPlaceFromUrl(resolved);
  if (!top) {
    const results = await searchGooglePlaces(parsed.placeName);
    if (results.length > 0) top = results[0];
  }
  if (!top) return null;

  const details = await getPlaceDetails(top.place_id);
  const category = mapToCategory((top.types || []));
  const location = details && details.address_components
    ? extractLocationFromComponents(details.address_components)
    : extractLocation((details && details.formatted_address) || top.formatted_address || '');

  return buildPinFromDetails({
    url,
    userId,
    ogData: { title: parsed.placeName, description: '', image: '' },
    details,
    topResult: top,
    category,
    location,
    confidenceScore: 90,
  });
}

/** AI-first pipeline: extract, dedup, AI places, Places API, return candidates. */
async function runAIPipeline({ url, userId, captionText }) {
  const isSocial = url.includes('instagram.com') || url.includes('tiktok.com');

  // Resolve social short URLs once so the TikTok-photo router below can see
  // the canonical /photo/ path. Without this, /t/ short URLs slip past the
  // isTikTokPhotoUrl() check and fall through to runYtDlp, which doesn't
  // support TikTok photo posts.
  let resolvedUrl = url;
  if (isSocial && isShortSocialUrl(url)) {
    try { resolvedUrl = await resolveOneRedirect(url); } catch {}
  }

  let extracted = null;
  if (isSocial) {
    try {
      if (isTikTokPhotoUrl(resolvedUrl)) {
        extracted = await fetchTikTokPhotoPost(resolvedUrl);
      } else if (isInstagramPostUrl(resolvedUrl)) {
        try {
          extracted = await fetchInstagramCarouselPost(resolvedUrl);
        } catch (igErr) {
          console.warn('IG embed extract failed, falling back to yt-dlp:', igErr.message);
          extracted = await runYtDlp(url);
        }
      } else {
        extracted = await runYtDlp(url);
      }
    } catch (err) {
      console.warn('social extraction failed, falling back to OG scraping:', err.message);
    }
  }

  const ogData = extracted
    ? {
        title: extracted.title || '',
        description: extracted.description || captionText || '',
        image: extracted.thumbnail_url || '',
        url,
        siteName: extractDomain(url),
      }
    : await fetchOGMetadata(url);
  if (!extracted && captionText) ogData.description = `${ogData.description}\n${captionText}`.trim();

  // Content-ID dedup (after extract, when webpage_url is canonical)
  const canonicalUrl = (extracted && extracted.webpage_url) || resolvedUrl;
  const contentId = extractContentId(canonicalUrl);
  if (contentId) {
    const dup = await findPinByContentId(userId, contentId);
    if (dup) return { duplicate: dup, candidates: [] };
  }

  // Parse @mentions from the caption and feed them into the AI prompt so
  // thin-caption photo carousels have a chance of hitting a venue handle.
  // The helper filters out obvious personal/creator handles upstream.
  const mentionedAccounts = parseMentionedAccounts(ogData.description || '');

  // AI extract places (multi) — text signals only
  const aiResult = await aiExtractPlaces({
    title: ogData.title,
    description: ogData.description,
    hashtags: extracted && extracted.hashtags,
    uploader: extracted && extracted.uploader,
    subtitles: extracted && extracted.subtitles,
    mentionedAccounts,
    collaborators: [], // yt-dlp doesn't currently surface IG Collab coauthors
  });

  // Vision pass for photo carousels. Fires whenever we have 2+ slide
  // images, not only when text AI returned empty — "10 best bars" listicle
  // carousels name one venue in caption and more on later slides. Vision
  // failure is swallowed so text-AI candidates still land as pins.
  const textPlaces = (aiResult && Array.isArray(aiResult.places)) ? aiResult.places : [];
  let visionPlaces = [];
  if (extracted && extracted.is_carousel && Array.isArray(extracted.slide_thumbnails) && extracted.slide_thumbnails.length >= 2) {
    try {
      const vres = await extractPlacesFromSlides({
        imageUrls: extracted.slide_thumbnails,
        contentId,
        caption: extracted.description || '',
        hashtags: extracted.hashtags || [],
        subtitles: extracted.subtitles || '',
      });
      visionPlaces = (vres.places || []).map((p) => ({
        name: p && typeof p === 'object' ? p.name : String(p || ''),
        city: p && typeof p === 'object' ? (p.location || '') : '',
        address: '',
        source: 'vision',
      }));
    } catch (err) {
      console.warn('vision extractPlacesFromSlides failed, continuing with text AI only:', err.message);
      visionPlaces = [];
    }
  }

  // Merge text + vision candidates, dedup by normalized name (so
  // "Café Nowhere" and "cafe nowhere" don't double-pin).
  const allCandidates = dedupe(
    [...textPlaces, ...visionPlaces],
    (p) => normalizePlaceName(p.name),
  );

  const candidates = [];
  if (allCandidates.length > 0) {
    for (const p of allCandidates) {
      const query = [p.name, p.address, p.city].filter(Boolean).join(' ');
      if (!query || query.trim().length < 3) continue;
      const results = await searchGooglePlaces(query);
      if (results.length === 0) continue;
      const top = results[0];
      // Per-place placeId dedup: skip if user already has this pin
      const existing = await findPinByPlaceId(userId, top.place_id);
      if (existing) continue;
      const details = await getPlaceDetails(top.place_id);
      if (!details) continue;
      const category = mapToCategory(top.types || details.types || []);
      const location = details.address_components
        ? extractLocationFromComponents(details.address_components)
        : extractLocation(details.formatted_address || top.formatted_address);
      candidates.push(buildPinFromDetails({
        url,
        userId,
        ogData,
        details,
        topResult: top,
        category,
        location,
        confidenceScore: 85,
      }));
    }
  }

  return { duplicate: null, candidates, ogData };
}

/** OG-first fallback pipeline (port of client processUrl) — used when AI returns no places. */
async function runOGFallback({ url, userId, captionText, ogData }) {
  const title = ogData.title || '';
  const description = ogData.description || '';

  let searchQuery = '';

  const singleAI = await aiExtractPlace({ title, description });
  if (singleAI && singleAI.length > 3) searchQuery = singleAI;

  if (!searchQuery) {
    const pinMarker = extractPinMarker(decodeHtmlEntities(description)) || extractPinMarker(decodeHtmlEntities(title));
    if (pinMarker && pinMarker.length > 2) searchQuery = pinMarker;
  }

  if (!searchQuery) {
    const captionQuery = captionText ? extractLocationQuery(captionText, '') : '';
    const ogQuery = extractLocationQuery(title, description);
    if (captionQuery.length > 3) searchQuery = captionQuery;
    else if (ogQuery.length > 3) searchQuery = ogQuery;
  }

  const garbage = ['instagram', 'tiktok', 'youtube', 'facebook', 'twitter', 'x'];
  const isGarbage = garbage.includes(searchQuery.toLowerCase().trim()) || searchQuery.trim().length < 3;
  if (isGarbage) return null;

  let results = await searchGooglePlaces(searchQuery);
  let { place, score } = calculateConfidence(results, ogData);

  if (place && score < 60) {
    const verification = await aiVerifyPlace(ogData, place.name, place.formatted_address, place.types);
    if (!verification.match && verification.betterQuery) {
      const aiResults = await searchGooglePlaces(verification.betterQuery);
      const check = calculateConfidence(aiResults, ogData);
      if (check.place) {
        place = check.place;
        score = Math.max(check.score, 60);
        results = aiResults;
      }
    }
  }

  if (!place || score < 30) return null;

  const existing = await findPinByPlaceId(userId, place.place_id);
  if (existing) return { duplicate: existing };

  const details = await getPlaceDetails(place.place_id);
  const category = mapToCategory((place.types || (details && details.types) || []));
  const location = details && details.address_components
    ? extractLocationFromComponents(details.address_components)
    : extractLocation((details && details.formatted_address) || (place && place.formatted_address) || '');

  return {
    pin: buildPinFromDetails({
      url,
      userId,
      ogData,
      details,
      topResult: place,
      category,
      location,
      confidenceScore: score,
    }),
  };
}

async function runEnrichment(jobId, url, userId, captionText) {
  if (!firestore) {
    console.error('runEnrichment called but Firestore is not initialized');
    return;
  }

  try {
    // 1. Raw-URL dedup
    const existingByUrl = await findPinByUrl(userId, url);
    if (existingByUrl) {
      await updateJob(jobId, { status: 'duplicate', existingPinId: existingByUrl.id, completedAt: ts() });
      await sendPushForJob(jobId, userId, 'duplicate', { placeName: existingByUrl.placeName, pinId: existingByUrl.id });
      return;
    }

    // 2. Google Maps URL short-circuit
    if (isGoogleMapsUrl(url)) {
      const pin = await handleGoogleMapsUrl(url, userId);
      if (pin) {
        const result = await writePinTransactional(pin, { title: pin.placeName });
        if (result.alreadyExists) {
          await updateJob(jobId, { status: 'duplicate', existingPinId: result.pinId, completedAt: ts() });
          await sendPushForJob(jobId, userId, 'duplicate', { placeName: pin.placeName, pinId: result.pinId });
        } else {
          await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
          await sendPushForJob(jobId, userId, 'complete', { placeName: pin.placeName, pinId: result.pinId });
        }
        return;
      }
    }

    // 3. AI-first pipeline
    const ai = await runAIPipeline({ url, userId, captionText });
    if (ai.duplicate) {
      await updateJob(jobId, { status: 'duplicate', existingPinId: ai.duplicate.id, completedAt: ts() });
      await sendPushForJob(jobId, userId, 'duplicate', { placeName: ai.duplicate.placeName, pinId: ai.duplicate.id });
      return;
    }

    if (ai.candidates.length === 1) {
      const result = await writePinTransactional(ai.candidates[0], ai.ogData);
      if (result.alreadyExists) {
        await updateJob(jobId, { status: 'duplicate', existingPinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'duplicate', { placeName: ai.candidates[0].placeName, pinId: result.pinId });
      } else {
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: ai.candidates[0].placeName, pinId: result.pinId });
      }
      return;
    }

    if (ai.candidates.length > 1) {
      await updateJob(jobId, {
        status: 'needs_selection',
        candidates: ai.candidates,
        ogTitle: (ai.ogData && ai.ogData.title) || '',
        ogImage: (ai.ogData && ai.ogData.image) || '',
        completedAt: ts(),
      });
      await sendPushForJob(jobId, userId, 'needs_selection');
      return;
    }

    // 4. OG-first fallback (single-place inference)
    const fallback = await runOGFallback({ url, userId, captionText, ogData: ai.ogData });
    if (fallback && fallback.duplicate) {
      await updateJob(jobId, { status: 'duplicate', existingPinId: fallback.duplicate.id, completedAt: ts() });
      await sendPushForJob(jobId, userId, 'duplicate', { placeName: fallback.duplicate.placeName, pinId: fallback.duplicate.id });
      return;
    }
    if (fallback && fallback.pin) {
      const result = await writePinTransactional(fallback.pin, ai.ogData);
      if (result.alreadyExists) {
        await updateJob(jobId, { status: 'duplicate', existingPinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'duplicate', { placeName: fallback.pin.placeName, pinId: result.pinId });
      } else {
        await updateJob(jobId, { status: 'complete', pinId: result.pinId, completedAt: ts() });
        await sendPushForJob(jobId, userId, 'complete', { placeName: fallback.pin.placeName, pinId: result.pinId });
      }
      return;
    }

    // 5. Give up
    await updateJob(jobId, {
      status: 'failed',
      error: 'No places could be extracted from this link',
      ogTitle: (ai.ogData && ai.ogData.title) || '',
      ogImage: (ai.ogData && ai.ogData.image) || '',
      completedAt: ts(),
    });
    await sendPushForJob(jobId, userId, 'failed');
  } catch (err) {
    console.error(`runEnrichment failed for job ${jobId}:`, err);
    try {
      await updateJob(jobId, {
        status: 'failed',
        error: String((err && err.message) || err).slice(0, 500),
        completedAt: ts(),
      });
      await sendPushForJob(jobId, userId, 'failed');
    } catch (writeErr) {
      console.error('Also failed to write failure status:', writeErr.message);
    }
  }
}

module.exports = { runEnrichment, setJob, updateJob };
