'use strict';

// Operator-created capability, NOT Firebase user/admin-header authentication.
// This collection has no client rule match. Never add a client mint/read route.
const express = require('express');
const rateLimit = require('express-rate-limit');
const {createHash, randomUUID, timingSafeEqual} = require('crypto');
const jobContext = require('./jobContext');
const {diagnosticReason}=require('./aiResponse');
const metrics = require('./engineMetrics');
const {createEngineFeatures} = require('./engineFeatures');
const {EngineError, asEngineError, MESSAGES} = require('./engineError');
const {isAllowedExtractUrl} = require('./urlValidation');
const {classifyContentProvider} = require('./contentProvider');
const {MEDIA_CONTROL} = require('./sharedAiStore');

const COLLECTION = 'engineMediaDiagnostics';
const ROUTE = '/internal/media-diagnostics';
const MAX_TICKET_MS = 15 * 60 * 1000;
const EXECUTION_MS = 120000;
const STATES = ['pending', 'running', 'completed', 'partial', 'failed', 'stopped', 'timed_out'];
const codeOf = error => Object.hasOwn(MESSAGES, error?.code) ? error.code : 'dependency_error';
const stopped = () => new EngineError('attempt_stopped', {stage:'media'});
const timeout = () => new EngineError('dependency_timeout', {stage:'media'});
const hashToken = token => createHash('sha256').update(token, 'utf8').digest();
const stopEnabled = control => !!control && (control.schemaVersion !== 1 || control.stopNewMediaDispatch !== false);

function bounded(work, ms) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeout()), Math.max(1, ms));
  })]).finally(() => clearTimeout(timer));
}
function validTicket(t, now) {
  // Version the remote capability so an older v1-only reader rejects audio-only
  // tickets instead of ignoring their mode and dispatching video work.
  return ((t?.schemaVersion === 1 && !Object.hasOwn(t, 'analysisMode'))
      || (t?.schemaVersion === 2 && t.analysisMode === 'audio-only')) && STATES.includes(t.status)
    && typeof t.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(t.tokenHash)
    && typeof t.userId === 'string' && t.userId.length > 0 && t.userId.length <= 128
    && typeof t.url === 'string' && t.url.length <= 2048 && isAllowedExtractUrl(t.url) && !!classifyContentProvider(t.url)
    && Number.isSafeInteger(t.createdAtMs) && t.createdAtMs >= 0 && t.createdAtMs <= now
    && Number.isSafeInteger(t.expiresAtMs) && t.expiresAtMs > t.createdAtMs
    && t.expiresAtMs - t.createdAtMs <= MAX_TICKET_MS;
}
function sameClaim(t, claim) {
  return t?.claimId === claim.claimId && t.tokenHash === claim.tokenHash
    && t.schemaVersion === claim.schemaVersion
    && t.userId === claim.userId && t.url === claim.url
    && Object.hasOwn(t, 'analysisMode') === Object.hasOwn(claim, 'analysisMode') && t.analysisMode === claim.analysisMode
    && t.createdAtMs === claim.createdAtMs && t.expiresAtMs === claim.expiresAtMs
    && t.deadlineMs === claim.deadlineMs;
}

// Only explicit output fields survive; no evidence refs/quotes, transcripts,
// frames, URLs, provider messages, stacks, retry capabilities or raw responses.
function safeText(value, limit) {
  if (typeof value !== 'string') return '';
  if (/https?:|www\.|bearer\s|authorization|api[-_]?key|[a-z0-9_-]{64,}/i.test(value)) return '[redacted]';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
}
function safeTiming(value) {
  const durationMs=value?.durationMs;
  if(!Number.isFinite(durationMs) || durationMs<=0 || durationMs>180000)return null;
  const timing={durationMs};
  if(Number.isFinite(value.audioStartMs) && value.audioStartMs>=0 && value.audioStartMs<=durationMs)timing.audioStartMs=value.audioStartMs;
  for(const name of ['probe','separateAudioProbe']) {
    const source=value[name],probe={};
    for(const stream of ['container','video','audio']) {
      const duration=source?.[`${stream}DurationMs`],start=source?.[`${stream}StartMs`];
      if(Number.isFinite(duration) && duration>0 && duration<=180000)probe[`${stream}DurationMs`]=duration;
      if(Number.isFinite(start) && Math.abs(start)<=180000)probe[`${stream}StartMs`]=start;
    }
    if(Object.keys(probe).length)timing[name]=probe;
  }
  for(const [name,max] of [['preparedChunkCount',32],['coverageGapCount',1001]]) {
    if(Number.isSafeInteger(value[name]) && value[name]>=0 && value[name]<=max)timing[name]=value[name];
  }
  for(const [name,max] of [['preparedIntervals',32],['coverageGaps',64]]) {
    if(Array.isArray(value[name]))timing[name]=value[name].slice(0,max).filter(v=>
      Number.isFinite(v?.startMs) && Number.isFinite(v?.endMs)
      && v.startMs>=0 && v.endMs>v.startMs && v.endMs<=durationMs)
      .map(({startMs,endMs})=>({startMs,endMs}));
  }
  return timing;
}
function safeResult(result, error, report, analysisMode) {
  const statuses = ['complete', 'partial', 'failed', 'unattempted', 'unavailable'];
  const reasons = [...Object.keys(MESSAGES), 'no_audio_track', 'no_distinct_frames', 'no_new_text',
    'sampled_frames_only', 'literal_claims_omitted', 'text_bound', 'candidate_bound', 'literal_evidence', 'audio_chunk_failed', 'audio_unread',
    'disabled_by_policy', 'submillisecond_tail', 'available_audio_complete'];
  const timing=safeTiming(result?.timing);
  return {
    schemaVersion:1,
    ...(timing?{timing}:{}),
    ...(analysisMode === 'audio-only' ? {analysisMode:'audio-only'} : {}),
    ...(diagnosticReason(error || result?.error) ? {responseValidation:diagnosticReason(error || result?.error)} : {}),
    attempted:result?.attempted === true,
    incomplete:!!error || result?.incomplete !== false,
    places:(Array.isArray(result?.places) ? result.places : []).slice(0, 120).map(place => ({
      name:safeText(place?.name, 300), city:safeText(place?.city, 500),
      country:safeText(place?.country, 500), address:safeText(place?.address, 500),
      source:['vision', 'transcript', 'subtitle', 'caption'].includes(place?.source) ? place.source : 'unknown',
    })),
    coverage:Object.fromEntries(['audio', 'visual', 'fusion'].map(key => {
      const c = result?.coverage?.[key];
      return [key, {
        status:statuses.includes(c?.status) ? c.status : 'unattempted',
        reason:reasons.includes(c?.reason) ? c.reason : null,
        intervals:(Array.isArray(c?.intervals) ? c.intervals : []).slice(0, 64).filter(v =>
          Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)
          && v[0] >= 0 && v[1] > v[0] && v[1] <= 180000)
          // Firestore rejects arrays directly containing another array.
          .map(([startMs, endMs]) => ({startMs, endMs})),
      }];
    })),
    errors:[...new Set([error, result?.error].filter(Boolean).map(codeOf))],
    // engineMetrics is itself bounded and allowlisted; it never receives text.
    metrics:report,
  };
}

function createMediaDiagnosticRouter({db, now = Date.now,
  extract = url => require('./extraction').extractPublicPost(url),
  collect = input => require('./media/videoEvidence').collectVideoEvidence(input),
} = {}) {
  const router = express.Router();
  const active = new Set();
  const controlRef = () => db.collection(MEDIA_CONTROL.collection).doc(MEDIA_CONTROL.document);
  const ticketRef = id => db.collection(COLLECTION).doc(id);

  async function claimTicket(id, token) {
    // The random owner is fixed across Firestore transaction retries. No work
    // starts inside the callback, or until the commit acknowledgement arrives.
    const claimId = randomUUID();
    return db.runTransaction(async tx => {
      const ref = ticketRef(id), t = (await tx.get(ref)).data();
      if (!validTicket(t, now()) || !timingSafeEqual(hashToken(token), Buffer.from(t.tokenHash, 'hex'))) {
        return {http:404, body:{error:'not_found'}};
      }
      if (t.status !== 'pending') return {http:t.status === 'running' ? 202 : 200,
        body:{status:t.status, ...(t.status === 'running' ? {executionExpired:!(t.deadlineMs > now())} : {})}};
      // Even an accidentally reset status cannot remove a consumed capability.
      if (t.claimId !== undefined || t.claimedAtMs !== undefined || t.deadlineMs !== undefined || t.result !== undefined) {
        return {http:410, body:{status:'stopped'}};
      }
      if (t.expiresAtMs <= now()) return {http:410, body:{status:'expired'}};
      const control = (await tx.get(controlRef())).data();
      if (stopEnabled(control)) {
        tx.update(ref, {status:'stopped', finishedAtMs:now()});
        return {http:410, body:{status:'stopped'}};
      }
      const claimedAtMs = now();
      if (t.expiresAtMs <= claimedAtMs) return {http:410, body:{status:'expired'}};
      const claim = {...t, id, status:'running', claimId, claimedAtMs,
        deadlineMs:Math.min(t.expiresAtMs, claimedAtMs + EXECUTION_MS)};
      tx.update(ref, {status:claim.status, claimId, claimedAtMs, deadlineMs:claim.deadlineMs});
      return {http:202, body:{status:'running', executionExpired:false}, claim};
    });
  }

  async function execute(claim) {
    const controller = new AbortController();
    // Only the validated ticket can opt into v2. Omission keeps the original
    // v1 policy shape; all subsequent authority checks fence this exact mode.
    const features = createEngineFeatures({version:'operator-media-diagnostic-v1', snapshotVersion:2,
      internalUids:[claim.userId], flags:{mediaEvidence:true, languageRouting:true},
      ...(claim.analysisMode === 'audio-only' ? {mediaPolicy:{policyVersion:'media-v2', analysisMode:'audio-only'}} : {}),
    }).forJob(claim.userId, undefined, ['mediaRecoveryV1']);
    async function assertAuthority() {
      if (controller.signal.aborted || now() >= claim.deadlineMs) throw timeout();
      await bounded(db.runTransaction(async tx => {
        const t = (await tx.get(ticketRef(claim.id))).data();
        const control = (await tx.get(controlRef())).data();
        if (!sameClaim(t, claim) || t.status !== 'running' || stopEnabled(control)) throw stopped();
      }), Math.min(5000, claim.deadlineMs - now()));
      if (controller.signal.aborted || now() >= claim.deadlineMs) throw timeout();
    }
    // No jobId/leaseOwner: assertActive must never read enrichmentJobs. Shared
    // operations revalidate this authority before authorizing each paid send.
    const context = {userId:claim.userId, attemptId:`media-diagnostic:${claim.id}:${claim.claimId}`,
      features, deadline:claim.deadlineMs, signal:controller.signal,
      beforeProviderDispatch:assertAuthority, validateProviderDispatch:assertAuthority};
    await jobContext.run(context, async () => {
      const telemetry = metrics.start({platform:classifyContentProvider(claim.url)});
      let result, error, timer, executionExpired=false;
      try {
        const work = (async () => {
          await assertAuthority();
          const extracted = await telemetry.stage('source', () => extract(claim.url));
          await assertAuthority();
          // A failed subtitle fetch can accompany usable metadata. Never turn
          // its 429/block/timeout into a second source reader or media download.
          const blocked = extracted?.subtitle_failures?.find(f =>
            ['rate_limited', 'access_blocked', 'dependency_timeout', 'attempt_stopped'].includes(f.code));
          if (blocked) throw new EngineError(blocked.code, {stage:'source'});
          return collect({url:claim.url, extracted,
            ogData:{title:extracted?.title || '', description:extracted?.description || ''},
            reason:'operator_diagnostic', retryOperations:[], baselinePlaces:[]});
        })();
        const cutoff = new Promise((_, reject) => {
          timer = setTimeout(() => {executionExpired=true; controller.abort(); reject(timeout());}, Math.max(1, claim.deadlineMs - now()));
        });
        result = await Promise.race([work, cutoff]);
        if (result?.attempted !== true || !Array.isArray(result.places) || !result.coverage
            || typeof result.incomplete !== 'boolean') throw new EngineError('invalid_response', {stage:'media'});
        await assertAuthority();
      } catch (cause) {error = asEngineError(cause, {stage:'media'});}
      finally {clearTimeout(timer); controller.abort();}
      const failure = error || result?.error;
      // The timer and wall clock can differ at the millisecond boundary. Once
      // the execution cutoff fires, it is authoritative even if Date.now lags.
      const status = failure?.code === 'dependency_timeout' && (executionExpired || now() >= claim.deadlineMs) ? 'timed_out'
        : failure?.code === 'attempt_stopped' ? 'stopped'
          : result?.incomplete ? 'partial' : error ? 'failed' : 'completed';
      const report = safeResult(result, error, telemetry.finish(status === 'completed' ? 'success'
        : status === 'partial' ? 'partial' : status === 'stopped' ? 'cancelled' : status === 'timed_out' ? 'timeout' : 'failed'),
        features.media.policy.analysisMode);
      // Publication may happen AFTER expiry, but never grants new execution.
      // A deleted/replaced ticket is not recreated. Revocation remains stopped.
      await bounded(db.runTransaction(async tx => {
        const ref = ticketRef(claim.id), t = (await tx.get(ref)).data();
        const control = (await tx.get(controlRef())).data();
        if (!sameClaim(t, claim) || !['running', 'stopped'].includes(t.status)) return;
        tx.update(ref, {status:t.status === 'stopped' || stopEnabled(control) ? 'stopped' : status, finishedAtMs:now(), result:report});
      }), 5000);
    });
  }

  router.use((_req, res, next) => {res.set('Cache-Control', 'no-store'); next();});
  // Fixed per-process fleet bound as well as IPv6-safe per-IP limiting. The
  // ticket transaction, not this in-memory limiter, enforces one execution.
  const limitOptions = {windowMs:60000, standardHeaders:true, legacyHeaders:false,
    message:{error:'rate_limited'}};
  router.use(rateLimit({...limitOptions, limit:12, keyGenerator:() => 'media-diagnostic'}));
  router.use(rateLimit({...limitOptions, limit:6, keyGenerator:req => rateLimit.ipKeyGenerator(req.ip)}));
  router.post('/:ticketId', express.raw({type:() => true, limit:'1kb', inflate:false}), async (req, res) => {
    const id = req.params.ticketId, token = req.get('x-media-diagnostic-token');
    if (!/^[a-f0-9]{32}$/.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(401).json({error:'unauthorized'});
    }
    if (Object.keys(req.query).length || (req.body && (!Buffer.isBuffer(req.body) || req.body.length))) {
      return res.status(400).json({error:'empty_request_required'});
    }
    if (!db) return res.status(503).json({error:'unavailable'});
    try {
      const outcome = await bounded(claimTicket(id, token), 5000);
      if (outcome.claim) {
        // Deliberately no durable queue, sweep, lease renewal or retry. Crash
        // between claim and invocation consumes the ticket without execution.
        const work = execute(outcome.claim).catch(() => { /* remains consumed; never log raw errors */ });
        active.add(work);
        work.finally(() => active.delete(work));
      }
      return res.status(outcome.http).json(outcome.body);
    } catch {return res.status(503).json({error:'unavailable'});}
  });
  router.use((_req, res) => res.status(404).json({error:'not_found'}));
  router.use((error, _req, res, _next) => res.status(error?.type === 'entity.too.large' ? 413 : 400)
    .json({error:'invalid_request'}));
  // Test/graceful-drain observation only; never restarts persisted running work.
  router.whenIdle = () => Promise.all([...active]);
  return router;
}

module.exports = {createMediaDiagnosticRouter, COLLECTION, ROUTE, MAX_TICKET_MS, EXECUTION_MS};
