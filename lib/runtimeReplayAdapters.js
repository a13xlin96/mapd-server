'use strict';
const fs = require('fs').promises;
const path = require('path');
const {randomUUID, createHash} = require('crypto');
const {createCaptureEvidenceBridge} = require('./runtimeReplayEvidence');
const {replayFeatures, selectiveDecision} = require('./runtimeReplayPolicy');
const {validateMediaConfig} = require('./media/mediaConfig');
const {missingIntervals} = require('./media/audioSegments');
const {mergeCandidates} = require('./media/mediaEligibility');
const {frameBatches} = require('./media/videoEvidence');
const {withMediaContext} = require('./media/mediaContext');
const {SERVER_PUBLIC_SCOPE} = require('./sharedAiIdentity');
const {createMetrics} = require('./engineMetrics');
const {usageFrom} = require('./engineBudgetPolicy');
const jobContext = require('./jobContext');
const {checksum} = require('./labeledEvaluationSchema');
const VERSION = require('./engineVersion');
const REGISTRY = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => {throw new Error(message);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const empty = () => ({status: 'unattempted', plannedRefs: [], observedRefs: [], reason: null});

/** Trusted compiled registration; never loaded by CLI path or input JSON.
 * transport=recorded requires injected OpenAI HTTP/Anthropic message fixtures.
 * transport=live uses the shipped provider clients, only after replay's explicit
 * authorized data/credential gate. Factory calls do not read keys or dispatch.
 * processing overrides are trusted decoder test doubles, not provider/model
 * outputs; defaults use shipped FFprobe, audioDecode and frameSelector.
 * No Firestore, Redis, source retrieval, production jobs or pin writes are used.
 * @returns stages accepted by replayMultimodal; registration owns per-case
 * workspace, cancellation, observation and local shared-operation lifecycle.
 */
function createRuntimeReplayAdapters({transport = 'recorded', providers = {}, processing = {}, policy = {}, prices} = {}) {
  if (!['recorded', 'live'].includes(transport) || process.env.NODE_ENV === 'production') fail('Replay adapters require an isolated non-production runner');
  if (transport === 'recorded' && (typeof providers.openaiFetch !== 'function' || typeof providers.anthropicCreateMessage !== 'function')) fail('Recorded provider fixtures required');
  if (transport === 'live' && Object.keys(providers).length) fail('Live credentials/providers must use registered server environment clients');
  if (Object.keys(processing).some(k => !['probe', 'decode', 'frames'].includes(k)) || Object.values(processing).some(f => typeof f !== 'function')) fail('Invalid trusted local processors');
  const config = validateMediaConfig(policy), features = replayFeatures(config);
  let permit = null, state = null;
  const owns = owner => !!owner && state === owner && permit === owner.permit && !owner.closed;
  const active = (owner = state) => {
    if (!owns(owner)) fail('cancelled');
    if (Date.now() >= owner.deadline) fail('deadline');
    if (owner.controller.signal.aborted || jobContext.current()?.signal?.aborted) fail('cancelled');
    return owner;
  };
  const scoped = work => {
    const s = active();
    if (jobContext.current()?.sharedMetrics === s.metrics) return work(s);
    return jobContext.run({deadline: s.deadline, signal: s.controller.signal, features,
      sharedMetrics: s.metrics, validateProviderDispatch: async () => {active(s);}}, () => work(s));
  };
  const sharedOptions = s => {active(s); return {policy: config, signal: jobContext.current()?.signal || s.controller.signal, scope: `user:replay-${s.permit.runId}`};};
  const publicOptions = s => ({...sharedOptions(s), scope: SERVER_PUBLIC_SCOPE});
  const mediaOptions = s => {active(s); return {config, signal: jobContext.current()?.signal || s.controller.signal, deadline: jobContext.current()?.deadline || s.deadline};};
  function recordCall(s, call, outcome, tokens) {
    if (call.recorded) return;
    call.recorded = true;
    s.metrics.providerCall({...call.details, outcome, tokens});
    s.metrics.recordStage(call.details.stage, Date.now() - call.began, outcome);
    s.pending.delete(call);
  }
  async function providerCall(s, provider, work, slots, observation) {
    active(s); const operation = jobContext.current()?.sharedOperation;
    if (!operation || !['asr_chunk', 'video_vision', 'media_fusion'].includes(operation.kind)) fail('Unregistered physical media operation');
    await operation.authorizeDispatch(); active(s);
    const call = {began: Date.now(), recorded: false, details: {provider, stage: observation.stage, rateKey: observation.rateKey,
      submittedAudioSeconds: observation.descriptor?.audioSeconds}};
    s.pending.add(call);
    try {
      const result = await work(); active(s);
      recordCall(s, call, 'success', usageFrom(result, null, provider));
      return result;
    } catch (error) {
      // Closed snapshots are immutable. A late producer belongs only to its
      // original case; it cannot charge or publish under the next case/run.
      if (owns(s)) recordCall(s, call, 'failed', usageFrom(null, error, provider));
      throw error;
    }
  }
  function services(s) {
    active(s); if (s.services) return s.services;
    const {createSharedAiOperations} = require('./sharedAiOperation');
    // Local, per-case operations exercise the shipped one-dispatch fence without
    // using any default production store or retaining public/private corpora.
    const operations = createSharedAiOperations({allowLocal: true});
    const sharedOperation = (options, work) => {
      active(s);
      return operations.runSharedAiOperation(options, async (...args) => {
        active(s); const result = await work(...args); active(s); return result;
      });
    };
    const boundProviderCall = providerCall.bind(null, s);
    const {createOpenAITranscription} = require('./media/providers/openaiTranscription');
    const adapter = createOpenAITranscription({fetchImpl: (...args) => {
      active(s); return (transport === 'recorded' ? providers.openaiFetch : globalThis.fetch)(...args);
    }, ...(transport === 'recorded' ? {getApiKey: () => 'offline-fixture-not-a-credential'} : {})});
    const createMessage = (...args) => {
      active(s); return transport === 'recorded' ? providers.anthropicCreateMessage(...args) : require('./anthropic').anthropic.messages.create(...args);
    };
    s.services = {
      transcribe: require('./media/transcriptionService').createTranscriptionService({providers: {openai: adapter}, sharedOperation, providerCall: boundProviderCall}).transcribe,
      fusion: require('./media/fuseEvidence').createEvidenceFusion({sharedOperation, providerCall: boundProviderCall, createMessage}),
      vision: require('./media/videoVision').createVideoVision({sharedOperation, providerCall: boundProviderCall, createMessage}),
    };
    return s.services;
  }
  async function ensureMedia(s, context) {
    active(s); const captures = context.assets.filter(a => a.kind === 'video');
    if (captures.length !== 1) fail('Registered replay requires one captured video per post');
    const video = captures[0];
    if (!Buffer.isBuffer(video.bytes) || hash(video.bytes) !== video.sha256 || video.bytes.length !== video.byteLength) fail('Captured video hash mismatch');
    // Both modalities share the same in-flight preparation, including errors.
    // A rejected probe must not lead the other arm to retry acquisition.
    if (s.videoSha && s.videoSha !== video.sha256) fail('Case video changed between arms');
    s.videoSha = video.sha256;
    s.prepPromise ||= (async () => {
      const {createWorkspace, sniffContainer} = require('./media/publicMediaDownload');
      const container = sniffContainer(video.bytes); if (!container) fail('Unsupported captured container');
      const workspace = await createWorkspace({maxBytes: config.maxWorkspaceBytes});
      if (!owns(s)) {await workspace.dispose(); fail('cancelled');}
      s.media = workspace;
      const release = workspace.retain();
      try {
        const filename = path.join(workspace.directory, `capture.${container}`);
        await fs.writeFile(filename, video.bytes, {mode: 0o600, flag: 'wx'}); active(s);
        Object.assign(workspace, {path: filename, container, contentDigest: video.sha256, bytes: video.byteLength});
        await workspace.assertQuota(); active(s);
        const processed = await (processing.probe || require('./media/mediaProcess').processMedia)({media: workspace, ...mediaOptions(s)});
        active(s); s.processed = processed;
        if (Math.abs(s.processed.durationMs - video.durationMs) > 1 || s.processed.durationMs > config.maxDurationMs) fail('Captured/probed duration mismatch');
      } finally {await release();}
    })();
    await s.prepPromise; active(s);
    return video;
  }
  function audioCoverage(s, video, transcript) {
    active(s); const intervals = transcript.coverage.intervals;
    const observedRefs = intervals.map(([lo, hi]) => s.bridge.audioRef(video.assetId, lo, hi));
    const missing = missingIntervals(intervals, s.processed.durationMs).map(([lo, hi]) => s.bridge.audioRef(video.assetId, lo, hi));
    return {status: missing.length ? observedRefs.length ? 'partial' : 'failed' : 'complete',
      plannedRefs: [...observedRefs, ...missing], observedRefs,
      reason: missing.length ? 'audio_unread' : null};
  }
  const stages = {
    async baseline(context) {
      const s = active();
      s.bridge = createCaptureEvidenceBridge(context.assetDescriptors);
      s.text = context.assets.filter(a => ['caption', 'subtitles'].includes(a.kind)).map(a => s.bridge.addText(a));
      // Baseline remains a recorded run over these exact captured bytes. The
      // media arms do not fabricate a fresh text extraction or its billing.
      return context.recordedResponse;
    },
    shouldEscalate: context => selectiveDecision({...context, features}),
    async audio(context) {
      return scoped(async s => {
        const video = await ensureMedia(s, context); active(s);
        if (!s.processed.hasAudio) return {text: '', observations: [], needsMoreEvidence: true,
          coverage: {...empty(), status: 'unavailable', reason: 'no_audio_track'}};
        const chunks = await (processing.decode || require('./media/audioDecode').prepareAudioChunks)({media: s.media, processed: s.processed, ...mediaOptions(s)});
        active(s);
        // Untimed captured subtitle text is useful evidence, but cannot claim
        // full native-cue coverage or silently bypass ASR.
        let transcript;
        try {transcript = await services(s).transcribe({durationMs: s.processed.durationMs, mediaDigest: video.sha256, chunks, provider: config.provider}, publicOptions(s));}
        catch (error) {active(s); if (error.partialResult) {transcript = error.partialResult; s.failure = 'stage_failed';} else throw error;}
        active(s);
        s.audioText = s.bridge.addTranscript(transcript, chunks, video);
        const coverage = audioCoverage(s, video, transcript);
        return {text: transcript.text, observations: [], needsMoreEvidence: coverage.status !== 'complete', coverage};
      });
    },
    async frames(context) {
      return scoped(async s => {
        const video = await ensureMedia(s, context); active(s);
        const selected = await (processing.frames || require('./media/frameSelector').selectFrames)({media: s.media, processed: s.processed,
          limit: Math.min(config.maxFrames, config.initialFrames * 2), ...mediaOptions(s)});
        active(s);
        const plannedRefs = s.bridge.addFrames(selected.frames, video);
        if (!plannedRefs.length) return {text: '', observations: [], needsMoreEvidence: true, coverage: {...empty(), status: 'unavailable', reason: 'no_selected_frames'}};
        const batches = frameBatches(selected.frames, config.initialFrames);
        const observedRefs = [], observations = [], quotes = []; let failed = false;
        s.visualObservations = [];
        for (const frames of batches) {
          try {
            const result = await services(s).vision({mediaDigest: video.sha256, durationMs: s.processed.durationMs, frames,
              textEvidence: []}, publicOptions(s));
            active(s); observations.push(...result.places.map(p => s.bridge.observation(p)));
            s.visualObservations.push(...result.observations);
            quotes.push(...result.observations.map(o => o.quote));
            observedRefs.push(...frames.map(f => plannedRefs[selected.frames.indexOf(f)]));
          } catch (error) {active(s); failed = true; s.failure = 'stage_failed'; break;}
        }
        // Deduplicate repeated batch findings without throwing away references.
        const evidence = require('./multimodalReplay').mergePieces([{text: quotes.join('\n'), observations}]);
        const partial = observedRefs.length < plannedRefs.length;
        return {...evidence, needsMoreEvidence: partial, coverage: {status: partial ? observedRefs.length ? 'partial' : 'failed' : 'complete',
          plannedRefs, observedRefs, reason: partial ? failed ? 'frame_batch_failed' : 'frame_bound' : null}};
      });
    },
    async fuse({pieces, baseline: baselineStage}) {
      return scoped(async s => {
        const baseline = baselineStage?.observations || [];
        let media = pieces.filter(p => p.coverage !== null).flatMap(p => p.observations), contradictions = [];
        const all = [...s.text, ...(s.audioText || []), ...s.bridge.addVisualObservations(s.visualObservations || [])];
        const textEvidence = []; let truncated = false;
        // Same bounded evidence policy as the shipped coordinator. Capture IDs
        // replace its title/description IDs without changing actual evidence.
        for (const item of all) {
          if (!item.text?.trim()) continue;
          if (item.text.length > 16000 || textEvidence.length >= 64 || Buffer.byteLength(JSON.stringify([...textEvidence, item])) > 23500) {truncated = true; continue;}
          textEvidence.push(item);
        }
        if (s.processed && textEvidence.some(e => e.modality !== 'caption')) {
          try {
            const found = await services(s).fusion({mediaDigest: s.media.contentDigest, durationMs: s.processed.durationMs, textEvidence,
              baselinePlaces: baseline.map(({name, city, country, address}) => ({name, city: city || '', country: country || '', address: address || ''}))}, sharedOptions(s));
            active(s);
            const fused = found.places.map(p => s.bridge.observation(p));
            media = truncated ? [...media, ...fused] : fused;
            contradictions = found.contradictions || [];
            for (const c of contradictions) for (const r of c.evidenceRefs) s.bridge.reference({...r, supports: 'name'});
          } catch (error) {active(s); s.failure = 'stage_failed';}
        }
        s.incomplete ||= truncated;
        return {text: pieces.map(p => p.text).join('\n'), observations: mergeCandidates(baseline, media, {contradictions, onOverflow: () => {s.incomplete = true;}})};
      });
    },
    match(context) {active(); return require('./multimodalReplay').matchFrozen({...context, mediaUsed: false});},
  };
  REGISTRY.set(stages, {
    authorize({mode, liveAuthorization, inputs}) {
      if (permit) fail('Registered replay is already running');
      if (transport === 'live' && (mode !== 'live' || liveAuthorization?.allowPaidInference !== true || liveAuthorization.permittedInputsSha256 !== checksum(inputs) || liveAuthorization.credentialSource !== 'server_environment')) fail('Live adapter requires authorized permitted captures');
      if (transport === 'recorded' && mode !== 'offline') fail('Recorded fixtures cannot masquerade as live inference');
      permit = {runId: liveAuthorization?.runId || randomUUID()};
    },
    beginCase(context) {
      if (!permit || state) fail('Invalid registered replay lifecycle');
      const controller = new AbortController(), cancel = () => controller.abort();
      context.signal?.addEventListener('abort', cancel, {once: true}); if (context.signal?.aborted) cancel();
      const deadline = Math.min(context.deadlineMs ?? Infinity, Date.now() + config.mediaTimeoutMs);
      const timer = setTimeout(cancel, Math.max(0, deadline - Date.now())); timer.unref?.();
      state = {controller, deadline, timer, cancel, parentSignal: context.signal, media: null, permit, closed: false, pending: new Set(),
        baselineMetrics: clone(context.baselineMetrics || []), platform: context.platform, language: context.language,
        metrics: createMetrics({platform: context.platform, language: context.language, queueMs: 0, ...(prices ? {prices} : {})})};
    },
    runMediaPhase(work) {
      return scoped(s => withMediaContext(work, {parent: jobContext.current(), reserveMs: 0,
        deadline: Math.max(Date.now() + 1, s.deadline - Math.min(15000, config.requestTimeoutMs))}));
    },
    async finishCase(result) {
      const s = state; if (!s) return [];
      if (s.finishPromise) return s.finishPromise;
      // Revoke the owning capability before aborting or awaiting cleanup. Shared
      // producers may outlive their subscriber, but cannot outlive this fence.
      s.closed = true; s.controller.abort(); clearTimeout(s.timer);
      s.parentSignal?.removeEventListener('abort', s.cancel);
      s.finishPromise = (async () => {try {
        for (const call of [...s.pending]) recordCall(s, call, 'cancelled', null);
        if (s.failure) {result.failure ||= s.failure; result.partial = true;}
        if (s.incomplete) result.partial = true;
        const baseline = s.baselineMetrics.length ? s.baselineMetrics : [createMetrics({platform: s.platform, language: s.language, processingMissingReason: 'not_observed'}).finish('unknown')];
        return [...baseline, s.metrics.finish(result.failure ? 'failed' : result.partial ? 'partial' : 'success')];
      } finally {
        try {await s.media?.dispose();} finally {
          s.services = null; s.bridge = null; s.text = null; s.audioText = null; s.visualObservations = null; s.prepPromise = null; s.media = null;
          if (state === s) state = null;
        }
      }})();
      return s.finishPromise;
    },
    async close() {const closingPermit = permit; try {if (state) await this.finishCase({failure: 'cancelled'});} finally {if (permit === closingPermit) permit = null;}},
    versions: {engine: VERSION.engine, prompt: 'grounded-crossmodal-v2.video-grounded-v1', model: `${config.model}:${VERSION.model}`, sampling: config.framePolicy, adapter: 'runtime-local-replay-v2'},
  });
  return Object.freeze(stages);
}
function registeredRuntimeAdapters(stages) {return REGISTRY.get(stages) || null;}
module.exports = {createRuntimeReplayAdapters, registeredRuntimeAdapters};
