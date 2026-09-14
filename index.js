const { persistThumbnail } = require('./lib/thumbnails');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { anthropic } = require('./lib/anthropic');
const { firestore, seedFeatureFlagsPromise } = require('./lib/firestore');
const { getCached, setCache } = require('./lib/cache');
const { extractPlacesFromSlides } = require('./lib/vision');
const { isAllowedExtractUrl } = require('./lib/urlValidation');
const { runEnrichment,saveSelectedPlaces } = require('./enrich');
const {admitEnrichmentJob} = require('./lib/enrichAdmission');
const {createWorker} = require('./lib/enrichmentWorker');
const worker = createWorker({db:firestore,runEnrichment,push:require('./lib/push').sendPushForJob});
const { router: adminRouter } = require('./lib/admin');
const { router: listMembershipRouter } = require('./lib/listMembership');
const { interestProfileRouter } = require('./lib/interestProfile');
const { authenticateRequest } = require('./lib/auth');
require('./lib/enrichmentSweeper'); // boots the orphan-job sweeper

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; req.ip must be the real client
app.use(express.json());

// Per-IP limiter for AI/extract routes. 60 req/min is ~10x a heavy human
// user; vision gets a tighter budget.
//
// These limiters run BEFORE authenticateRequest in the chain — deliberate,
// so a flood of unauthenticated traffic gets rejected without spending a
// token-verification round-trip on each request. That means req.authUid is
// never set yet when the key is computed here, so this is per-IP limiting
// ONLY, not per-user: two different authenticated users behind the same IP
// (e.g. NAT, corporate proxy) share one bucket. Per-user keying would
// require flipping the order to auth-then-limit; we're accepting the
// per-IP tradeoff for now to keep flood traffic cheap to reject.
//
// keyGenerator uses express-rate-limit's ipKeyGenerator helper rather than
// raw req.ip — v8+ requires it so IPv6 clients can't dodge the bucket by
// varying their address within a /64.
//
// Store is the express-rate-limit default: in-memory. A Render restart
// resets all buckets, and running a second instance would split traffic
// across separate in-process buckets instead of sharing one. @upstash/redis
// is already a dependency here if a shared store is ever needed.
function rateLimitKeyGenerator(req) {
  return ipKeyGenerator(req.ip);
}
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});
const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

// Admin endpoints (collaborative-lists migration). Gated by ADMIN_TOKEN env
// var — not a Firebase Auth ID token. See lib/admin.js for the workflow.
app.use(adminRouter);

// listMembership's router-mounted routes deliberately don't get apiLimiter
// (they're keyed on a listId+pinId the caller must already know/own).
// POST /lists/join is the one exception: it's the sole path that checks an
// invite token, and while tokens are still 8-char Math.random() strings
// (pre S2-Task-3 crypto-random rollout), an unlimited caller could
// brute-force valid tokens — with every guess billing a Firestore query.
// Mounted path-scoped and ahead of the router mount below so only this one
// route gets the limiter, applied before authenticateRequest like the
// AI/extract routes (rejects flood traffic without paying a token-verify
// round-trip per request).
app.use('/lists/join', apiLimiter);

// S3 pins-privacy-lockdown plan, Task 2: GET /lists/:listId/pins is the
// server-side replacement for the client's `where('listIds','array-
// contains', listId)` query over foreign pins (shared-list fallback +
// featured-list cloning), which the soon-to-tighten Firestore rules will
// deny. Unlike the other listMembership routes it's readable with just a
// listId the caller may not otherwise have any relationship to yet (e.g.
// any signed-in user can hit it for a featured list), so — like
// /lists/join — it gets its own path-scoped limiter rather than staying
// unlimited.
//
// Mounted as its own `app.use` (not folded into a single `app.use('/lists',
// apiLimiter)` covering the whole router) so the other listMembership
// routes — /lists/:listId/members/:pinId/remove and .../overrides — keep
// their deliberately-unlimited status: those are keyed on a listId+pinId
// pair the caller must already know/own, per the comment below. Verified
// the two path patterns don't overlap (`/lists/join` vs
// `/lists/:listId/pins`), so this can't double-apply the limiter to a
// single request.
app.use('/lists/:listId/pins', apiLimiter);

// visitedBy-chips restoration: GET /lists/:listId/visits is the
// server-side replacement for the client's `collectionGroup('visits')
// .where('userId','in', otherUids)` query (see lib/listMembership.js for
// the full rationale, including why it deliberately does NOT extend
// featured-list access the way /pins does). Same reasoning as /pins for
// getting its own path-scoped limiter here rather than folding into a
// single `app.use('/lists', apiLimiter)`: it's readable with just a
// listId the caller may not otherwise have a relationship to, unlike the
// listId+pinId-keyed remove/overrides routes on the same router that
// stay deliberately unlimited.
app.use('/lists/:listId/visits', apiLimiter);

// User-auth list-membership endpoints (Phase 4 foreign-pin removal).
app.use(listMembershipRouter);

// S5 interest-profile-server-side plan, Task 1: POST /interest-profile/pin-saved
// writes the monetization-critical save-behavior signal server-side, with
// uid from the verified token (never the body). Path-scoped apiLimiter
// mounted ahead of the router, mirroring '/lists/join' above — this is the
// interest-profile router's only route and, like the other AI/extract
// routes, gets a flood-cheap per-IP limiter ahead of authenticateRequest.
app.use('/interest-profile', apiLimiter);
app.use(interestProfileRouter);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'mapd-link-extractor' });
});

// Privacy Policy
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mapd — Privacy Policy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F9F8F6; color: #1C1917; line-height: 1.7; padding: 24px; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    h2 { font-size: 20px; font-weight: 600; margin-top: 32px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #44403C; margin-bottom: 12px; }
    ul { padding-left: 20px; }
    .updated { font-size: 13px; color: #A8A29E; margin-bottom: 24px; }
    a { color: #D4622A; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: April 10, 2026</p>

  <p>Mapd ("we", "our", or "us") operates the Mapd mobile application. This policy describes how we collect, use, and protect your information.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Account Information:</strong> When you sign in with Google, we receive your name, email address, and profile photo. This is used solely for authentication and displaying your profile within the app.</li>
    <li><strong>Saved Places:</strong> Places you save (pins), lists you create, and notes you add are stored in our database to provide the core app functionality.</li>
    <li><strong>Shared Links:</strong> When you share links from Instagram, TikTok, or Google Maps to Mapd, we process the URL to extract place information. The URLs and extracted metadata are logged for analytics and to improve the service.</li>
    <li><strong>Location Data:</strong> With your permission, we access your device's precise location to show your position on the map and to improve place search results. We do not store your location history on our servers.</li>
    <li><strong>Usage Data:</strong> We collect analytics events (such as pins saved, links processed, and features used) to understand how the app is used and to improve it. These events are linked to your user ID.</li>
    <li><strong>Diagnostics:</strong> We collect crash reports and performance data to maintain app stability. This data is not linked to your identity.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To provide and maintain the app's core features (saving places, creating lists, sharing with friends)</li>
    <li>To authenticate your account and secure your data</li>
    <li>To process shared links and extract place information</li>
    <li>To analyze usage patterns and improve the app</li>
    <li>To diagnose technical issues and fix bugs</li>
  </ul>

  <h2>Third-Party Services</h2>
  <p>We use the following third-party services to operate the app:</p>
  <ul>
    <li><strong>Google Firebase:</strong> Authentication, database, and crash reporting</li>
    <li><strong>Google Places API:</strong> Place search and details</li>
    <li><strong>Google Maps:</strong> Map display</li>
    <li><strong>Anthropic (Claude AI):</strong> Extracting place names from social media post captions (text only, no personal data is sent)</li>
  </ul>
  <p>We do not sell, rent, or share your personal information with third parties for advertising or marketing purposes.</p>

  <h2>Data Storage and Security</h2>
  <p>Your data is stored in Google Firebase (Cloud Firestore) with security rules that restrict access to authenticated users. Each user can only read and modify their own data. We use industry-standard security measures to protect your information.</p>

  <h2>Data Retention</h2>
  <p>Your account data and saved places are retained as long as your account is active. Cached data (link extractions, place lookups) expires automatically after 7–30 days. You can delete your account and all associated data at any time by contacting us.</p>

  <h2>Your Rights</h2>
  <p>You have the right to:</p>
  <ul>
    <li>Access your personal data</li>
    <li>Request correction of inaccurate data</li>
    <li>Request deletion of your account and data</li>
    <li>Export your saved places data</li>
  </ul>
  <p>To exercise any of these rights, contact us at the email below.</p>

  <h2>Children's Privacy</h2>
  <p>Mapd is not intended for children under 13. We do not knowingly collect personal information from children under 13.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy from time to time. We will notify you of significant changes through the app or by updating the date at the top of this page.</p>

  <h2>Contact Us</h2>
  <p>If you have questions about this privacy policy or your data, contact us at: <a href="mailto:mapdnyc@gmail.com">mapdnyc@gmail.com</a></p>
</body>
</html>`);
});

// Invite landing page — opens app if installed, shows download page if not
app.get('/invite/:token', (req, res) => {
  const { token } = req.params;
  const appScheme = `mapd://join/${token}`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join a list on Mapd</title>
  <meta property="og:title" content="You've been invited to a list on Mapd">
  <meta property="og:description" content="Mapd turns your saved Instagram and TikTok posts into pins on a map.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #F9F8F6;
      color: #1C1917;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .logo { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { font-size: 16px; color: #78716C; margin-bottom: 32px; line-height: 1.5; }
    .code {
      background: #FDE8DE;
      color: #D4622A;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 8px;
      font-size: 18px;
      letter-spacing: 1px;
      display: inline-block;
      margin-bottom: 32px;
    }
    .btn {
      display: block;
      width: 100%;
      max-width: 300px;
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      margin-bottom: 12px;
    }
    .btn-primary { background: #D4622A; color: #fff; }
    .btn-secondary { background: #fff; color: #1C1917; border: 1px solid #E7E5E4; }
    .stores { display: flex; gap: 12px; margin-top: 24px; }
    .stores a {
      padding: 10px 20px;
      background: #1C1917;
      color: #fff;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
    }
    .divider { color: #A8A29E; font-size: 14px; margin: 16px 0; }
    .footer { margin-top: 40px; font-size: 12px; color: #A8A29E; }
  </style>
</head>
<body>
  <div class="logo">📍</div>
  <h1>You're invited to a list on Mapd</h1>
  <p class="subtitle">Save places from Instagram & TikTok to a shared map with friends.</p>

  <a href="${appScheme}" class="btn btn-primary" id="openApp">Open in Mapd</a>

  <p class="divider">Don't have the app yet?</p>

  <p class="subtitle">Enter this invite code in the app:</p>
  <div class="code">${token}</div>

  <div class="stores">
    <a href="#">App Store</a>
    <a href="#">Google Play</a>
  </div>

  <p class="footer">Mapd — your places, on your map</p>

  <script>
    // Try to open the app, fall back gracefully
    document.getElementById('openApp').addEventListener('click', function(e) {
      e.preventDefault();
      var appUrl = '${appScheme}';
      window.location.href = appUrl;
      // If app doesn't open after 1.5s, stay on this page
      setTimeout(function() {
        // User is still here — app didn't open
      }, 1500);
    });
  </script>
</body>
</html>`);
});

// Manual-link images are cached per caller; only server extraction can populate
// the shared cache, so an arbitrary client image cannot poison another user's cover.
app.post('/thumbnails/persist', apiLimiter, authenticateRequest, async (req, res) => {
  const { imageUrl, sourceUrl } = req.body || {};
  if (typeof imageUrl !== 'string' || imageUrl.length > 8192 || typeof sourceUrl !== 'string' || !isAllowedExtractUrl(sourceUrl)) {
    return res.status(400).json({ error: 'invalid_thumbnail_request' });
  }
  const image = await persistThumbnail(imageUrl, sourceUrl, req.authUid);
  return res.json({ image });
});

// Extract metadata from a social media link
app.post('/extract', apiLimiter, authenticateRequest, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isAllowedExtractUrl(url)) {
    return res.status(400).json({ error: 'unsupported or invalid url' });
  }

  try {
    const data = await require('./lib/extraction').extractPublicPost(url);
    res.json({...data, thumbnail_url:await persistThumbnail(data.thumbnail_url,data.webpage_url || url)});
  } catch (error) {
    const failure = require('./lib/engineError').failureOf(error);
    res.status(422).json({error:failure.message,code:failure.code,failure});
  }
});

// Worker and compatibility endpoints share validation and versioned AI logic.
const engineAI = require('./enrich/ai');
const {withProvider} = require('./lib/providerRuntime');
const {failureOf} = require('./lib/engineError');
app.post('/ai/extract-places', apiLimiter, authenticateRequest, async (req, res) => {
  try { res.json(await engineAI.aiExtractPlaces(req.body, {scope:`user:${req.authUid}`})); }
  catch (e) { const failure = failureOf(e); res.status(502).json({error:failure.message,code:failure.code,failure}); }
});
app.post('/ai/extract-place', apiLimiter, authenticateRequest, async (req, res) => {
  try { res.json(await engineAI.aiExtractSingle(req.body, {scope:`user:${req.authUid}`})); }
  catch (e) { const failure = failureOf(e); res.status(502).json({error:failure.message,code:failure.code,failure}); }
});
app.post('/ai/verify-place', apiLimiter, authenticateRequest, async (req, res) => {
  const {placeName,placeAddress,placeTypes} = req.body;
  res.json(await engineAI.aiVerifyPlace(req.body,placeName,placeAddress,placeTypes));
});

// AI: Infer city/country for each place using ALL siblings in the list as context.
// Used by the Google Takeout import flow and by the "Re-resolve from link" pin action
// when the original URL doesn't carry coordinates.
app.post('/ai/infer-place-regions', apiLimiter, authenticateRequest, async (req, res) => {
  const { places, listName, siblingPlaces } = req.body;

  if (!Array.isArray(places) || places.length === 0) {
    return res.status(400).json({ error: 'places array required' });
  }

  const cleanPlaces = places
    .map((p) => ({ name: String(p?.name || '').trim(), url: String(p?.url || '').trim() }))
    .filter((p) => p.name);
  const cleanSiblings = Array.isArray(siblingPlaces)
    ? siblingPlaces.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const cleanListName = String(listName || '').trim();

  if (cleanPlaces.length > 40 || cleanSiblings.length > 100 || JSON.stringify({cleanPlaces,cleanSiblings,cleanListName}).length > 24000) {
    return res.status(400).json({error:'input_too_large'});
  }

  if (cleanPlaces.length === 0) {
    return res.status(400).json({ error: 'no valid place names' });
  }

  const cacheKey = engineAI.cacheKey('infer-regions', {cleanListName,cleanPlaces,cleanSiblings}, `user:${req.authUid}`);
  const cached = await getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const allContextNames = Array.from(new Set([
      ...cleanPlaces.map((p) => p.name),
      ...cleanSiblings,
    ]));

    const placesBlock = cleanPlaces
      .map((p, i) => `${i + 1}. "${p.name}"${p.url ? `\n   URL: ${p.url}` : ''}`)
      .join('\n');

    const prompt = `You are identifying the location of places saved in a user's map list.

Use ALL available context to disambiguate. A place name alone ("Joe's Pizza") is often ambiguous because the same name exists in many cities worldwide. But when sibling places in the same list clearly point to one region, use that regional context to place the ambiguous ones.

Priority of signals (strongest first):
1. The place name itself if it's unique or tied to a landmark ("Sagrada Familia")
2. Sibling places in the same list — if most siblings are in Barcelona, an ambiguous "Joe's Pizza" in that list is very likely also in Barcelona
3. The list name if it names a place ("Spain", "Tokyo Trip")
4. Any hints in the URL slug

Return "confidence": "low" and null city/country ONLY if the name is so generic AND the siblings give no regional signal. When siblings cluster in one region, treat that as strong evidence and use "medium" or "high".

List name: ${cleanListName ? `"${cleanListName}"` : '(none)'}
All places in this list (for regional context): ${allContextNames.map((n) => `"${n}"`).join(', ')}

Places to identify:
${placesBlock}

Return ONLY valid JSON in this exact shape:
{"results":[{"name":"<exact input name>","city":"<city or null>","country":"<country or null>","confidence":"high|medium|low"}]}`;

    const message = await withProvider('anthropic',() => anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2400,
      messages: [{ role: 'user', content: prompt }],
    },{timeout:30000,maxRetries:0}),4);

    const parsed = engineAI.parseResponse(message);
    if (!Array.isArray(parsed?.results) || parsed.results.some(r=>!r || typeof r.name!=='string' || !['city','country'].every(k=>r[k]==null || typeof r[k]==='string'))) throw new Error('Invalid region inference');
    const results = parsed.results;

    // Normalize: ensure every input place has a corresponding result.
    const byName = new Map(results.map((r) => [String(r?.name || '').trim(), r]));
    const normalized = cleanPlaces.map((p) => {
      const r = byName.get(p.name) || {};
      const confidence = ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low';
      return {
        name: p.name,
        city: r.city || null,
        country: r.country || null,
        confidence,
      };
    });

    const response = { results: normalized };
    await setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('AI infer-place-regions failed:', error.message);
    const failure=failureOf(error,{stage:'ai',provider:'anthropic'});
    res.status(502).json({failure,error:failure.message,results: cleanPlaces.map((p) => ({ name: p.name, city: null, country: null, confidence: 'low' }))});
  }
});

// AI Vision: Extract place names from carousel slide images.
// Thin wrapper around lib/vision.js so the shared helper can be reused
// by /enrich without duplicating cache/prompt logic.
app.post('/ai/vision-extract', apiLimiter, visionLimiter, authenticateRequest, async (req, res) => {
  const { imageUrls, contentId, caption, hashtags, subtitles } = req.body;
  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'imageUrls array required' });
  }
  try {
    const result = await extractPlacesFromSlides({ imageUrls, contentId, caption, hashtags, subtitles },{scope:`user:${req.authUid}`});
    res.json(result);
  } catch(error) {const failure=failureOf(error);res.status(502).json({error:failure.message,code:failure.code,failure});}
});

// Authenticate /enrich requests. See lib/auth.js for the shared
// authenticateRequest middleware (Bearer verify + admin-token path).

// The phone and Cloud Function both durably admit a pending job. The worker
// claims it later, so a process exit between HTTP response and execution cannot
// lose accepted work. Redelivery never restarts a processing or terminal job.
app.post('/enrich/selection', apiLimiter, authenticateRequest, async (req,res)=>{
  const {jobId,selectedPlaceIds}=req.body || {};
  if(typeof jobId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) return res.status(400).json({error:'invalid_job'});
  try {res.json(await saveSelectedPlaces(jobId,req.authUid,selectedPlaceIds));}
  catch(error) {const failure=failureOf(error);res.status(failure.code==='access_blocked'?403:502).json({failure,error:failure.message});}
});

app.post('/enrich', apiLimiter, authenticateRequest, async (req, res) => {
  const { url, userId, captionText, jobId, retryOf } = req.body || {};
  console.log(`[/enrich] job=${jobId || '?'} user=${userId || '?'} url=${url || '?'} admin=${req.adminBypass ? 1 : 0}`);

  if (!url || !userId || !jobId) {
    return res.status(400).json({ error: 'url, userId, and jobId are required' });
  }
  if (userId !== req.authUid) {
    return res.status(403).json({ error: 'userId does not match authenticated user' });
  }
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore not configured on server' });
  }

  let result;
  try {
    result = await admitEnrichmentJob(firestore, {
      jobId,
      userId,
      url,
      captionText,
      adminBypass: !!req.adminBypass,
      retryOf,
    });
  } catch (err) {
    console.error('/enrich claim failed:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }

  worker.nudge();

  return res.status(result.code).json(result.body);
});

const PORT = process.env.PORT || 3000;
// F59 round-2: gate listen() on the featureFlags seed so user-facing
// routes cannot observe a missing-doc state during a fresh deploy's
// first few hundred ms. Round-3: cap the wait with a timeout so a
// hung Firestore RPC can't wedge the deploy (health checks would
// fail, the process would never listen). Seed failure or timeout
// is non-fatal because the routes themselves still have the
// fail-closed 409 trip-wire.
const SEED_BOOT_TIMEOUT_MS = 5000;
function bootListen() {
  worker.start();
  app.listen(PORT, () => {
    console.log(`Mapd link extractor running on port ${PORT}`);
  });
}
if (require.main === module) {
  let seedTimer;
  const seedTimeout = new Promise(resolve => {
    seedTimer = setTimeout(() => resolve({action:'timed-out'}),SEED_BOOT_TIMEOUT_MS);
  });
  Promise.race([seedFeatureFlagsPromise,seedTimeout])
    .then(result => {
      if (result?.action === 'timed-out') console.warn(`featureFlags seed did not complete within ${SEED_BOOT_TIMEOUT_MS}ms; listening anyway`);
    })
    .finally(() => {clearTimeout(seedTimer);bootListen();});
}
// Importing the actual routes for tests must not bind a port or start workers.
module.exports = {app,bootListen};
