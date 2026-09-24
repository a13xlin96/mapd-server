'use strict';
// Contract integration with synthetic local bytes and provider fixtures ONLY.
// The real shipped ASR/vision/fusion validators and operation fence execute.
jest.mock('../lib/cache', () => ({redis: null}));
jest.mock('../lib/firestore', () => {throw new Error('Production store must not load during replay');});
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createHash, randomUUID} = require('crypto');
const {fixture, copy} = require('./helpers/multimodalEvaluationFixture');
const {checksum, sealCorpus, validatePredictions} = require('../lib/labeledEvaluationSchema');
const {createReplayInputs, replayMultimodal} = require('../lib/multimodalReplay');
const {createRuntimeReplayAdapters, registeredRuntimeAdapters} = require('../lib/runtimeReplayAdapters');
const jobContext = require('../lib/jobContext');
const {selectiveDecision} = require('../lib/runtimeReplayPolicy');
const {createCaptureEvidenceBridge} = require('../lib/runtimeReplayEvidence');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const message = value => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(value)}], usage: {input_tokens: 100, output_tokens: 20}});
const ref = (evidenceId, quote, supports, extra = {}) => ({evidenceId, quote, supports, ...extra});
function integrationFixture(dir) {
  const f = fixture(), part = f.selected[1], row = part.row;
  const header = Buffer.alloc(16); header.writeUInt32BE(16); header.write('ftypisom', 4);
  const videoBytes = Buffer.concat([header, Buffer.from(`SYNTHETIC container-header fixture ${row.caseId}`)]);
  const video = row.assets[1]; video.sha256 = hash(videoBytes); video.byteLength = videoBytes.length;
  row.evidenceSha256 = checksum(row.assets);
  const visual = {venueId: `visual-${row.caseId}`, branchId: 'paris'};
  row.expectedVenues.push(visual); row.supports.push({...visual, nameRefs: [copy(part.frameRef)], branchRefs: [copy(part.captionRef)]});
  row.coverage.push('multiple_places');
  f.corpus.cases = [...f.corpus.cases.filter(c => c.split === 'development'), row]; f.seal = sealCorpus(f.corpus);
  f.inputs = createReplayInputs(f.corpus, f.seal, 'holdout');
  f.recordings.cases = [copy(f.recordings.cases.find(r => r.caseId === row.caseId))];
  f.recordings.cases[0].responses.audio = null; f.recordings.cases[0].responses.frames = null;
  f.recordings.inputsSha256 = checksum(f.inputs);
  f.places.inputsSha256 = checksum(f.inputs); f.places.entries = [f.places.entries.find(e => e.caseId === row.caseId)];
  f.places.entries.push({caseId: row.caseId, query: 'Visual Cafe Paris', results: [{place_id: 'visual-place', name: 'Visual Cafe', formatted_address: 'Paris France', lat: 48.85, lng: 2.35, ...visual}]});
  for (const a of row.assets) fs.writeFileSync(path.join(dir, `${a.sha256}.bin`), a.kind === 'video' ? videoBytes : f.files.get(a.sha256));
  const chunks = [[0, 20000], [19000, 30000]].map(([startMs, endMs]) => {
    const audioBytes = Buffer.from(`RIFF0000WAVEsynthetic-pcm-${startMs}`);
    return {audioBytes, audioSha256: hash(audioBytes), startMs, endMs};
  });
  const paths = [];
  const processing = {
    probe: jest.fn(async ({media}) => {
      paths.push(media.directory); expect(fs.readFileSync(media.path)).toEqual(videoBytes);
      return {durationMs: 30000, width: 1, height: 1, hasAudio: true, clipStartMs: 0, clipEndMs: 30000};
    }),
    decode: jest.fn(async () => chunks),
    frames: jest.fn(async ({media}) => ({frames: [{bytes: png, digest: hash(png), sourceDigest: media.contentDigest, width: 1, height: 1, timestampMs: 1000, crop: [0, 0, 1, 1]}]})),
  };
  const providers = {
    openaiFetch: jest.fn(async (_url, init) => {
      expect(init.body.get('model')).toBe('gpt-4o-mini-transcribe-2025-12-15');
      return {ok: true, headers: {get: () => null}, text: async () => JSON.stringify({text: `${part.name} Paris`, usage: {type: 'duration', seconds: 20}})};
    }),
    anthropicCreateMessage: jest.fn(async (body, options) => {
      expect(options.maxRetries).toBe(0);
      const content = body.messages[0].content;
      if (typeof content === 'string') {
        const evidence = JSON.parse(content.split('\nEvidence: ')[1]);
        const audio = evidence.find(e => e.modality === 'transcript'), caption = evidence.find(e => e.modality === 'caption');
        const visual = evidence.find(e => e.modality === 'visual');
        return message({places: [
          ...(audio ? [{name: part.name, city: 'Paris', evidenceRefs: [ref(audio.evidenceId, part.name, 'name'), ref(caption.evidenceId, 'Paris', 'city')]}] : []),
          ...(visual ? [{name: 'Visual Cafe', city: 'Paris', evidenceRefs: [ref(visual.evidenceId, 'Visual Cafe', 'name'), ref(caption.evidenceId, 'Paris', 'city')]}] : []),
        ], contradictions: []});
      }
      const prompt = content.at(-1).text, manifest = JSON.parse(prompt.split('Frame manifest: ')[1].split('\nText evidence: ')[0]);
      expect(JSON.parse(prompt.split('\nText evidence: ')[1])).toEqual([]);
      const id = manifest[0].evidenceId, region = [0, 0, 1, 1];
      return message({observations: [{evidenceId: id, quote: 'Visual Cafe', region}], places: [{name: 'Visual Cafe', evidenceRefs: [ref(id, 'Visual Cafe', 'name', {region})]}]});
    }),
  };
  return {f, part, chunks, providers, processing, paths, videoBytes, options: {inputs: f.inputs, recordings: f.recordings, places: f.places, directory: dir}};
}
describe('registered shipped-media replay adapters', () => {
  let dir, t;
  beforeEach(() => {dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-replay-test-')); t = integrationFixture(dir);});
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));
  test('executes shipped ASR HTTP adapter, text fusion, vision, grounding and matcher on local captures', async () => {
    const network = jest.spyOn(global, 'fetch').mockImplementation(() => {throw new Error('Unexpected network');});
    try {
      const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
      const [p] = await replayMultimodal({...t.options, stages, arms: ['combined']});
      expect(p.results[0].failure).toBeNull();
      expect(p.results[0].analysis.audio.status).toBe('complete'); expect(p.results[0].analysis.frames.status).toBe('complete');
      expect(p.results[0].candidates.map(c => c.venueId).sort()).toEqual(t.part.row.expectedVenues.map(v => v.venueId).sort());
      expect(p.results[0].candidates.every(c => c.requiresSelection)).toBe(true);
      expect(p.results[0].confirmedSaved).toEqual([]); expect(p.results[0].autoSaved).toEqual([]);
      expect(validatePredictions(p, t.f.corpus, t.f.seal)).toBe(p);
      expect(t.providers.openaiFetch).toHaveBeenCalledTimes(2); expect(t.providers.anthropicCreateMessage).toHaveBeenCalledTimes(2);
      expect(t.processing.probe).toHaveBeenCalledTimes(1); // One owned capture reused by both modalities.
      expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
      const kinds = p.results[0].attemptMetrics.flatMap(m => m.providerCalls.map(c => c.stage));
      expect(kinds.sort()).toEqual(['media_fusion', 'transcription', 'transcription', 'video_vision']);
      expect(p.results[0].attemptMetrics[0].processingMissingReason).toBe('not_observed'); // baseline was not instrumented.
      expect(network).not.toHaveBeenCalled();
    } finally {network.mockRestore();}
  });
  test('frames arm fuses actual OCR with caption but never performs ASR', async () => {
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['frames']});
    expect(p.results[0].candidates).toHaveLength(1); expect(p.results[0].analysis.audio.status).toBe('unattempted');
    expect(t.providers.openaiFetch).not.toHaveBeenCalled(); expect(t.providers.anthropicCreateMessage).toHaveBeenCalledTimes(2);
    expect(p.timing).toBe('diagnostic_non_production');
    expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
  });
  test('combined runs modalities concurrently, prepares once and fuses complementary clues only after both settle', async () => {
    let releaseAudio, releaseFrames;
    const audioStarted = new Promise(resolve => {releaseAudio = resolve;});
    const framesStarted = new Promise(resolve => {releaseFrames = resolve;});
    const originalAudio = t.processing.decode.getMockImplementation(), originalFrames = t.processing.frames.getMockImplementation();
    t.processing.decode.mockImplementation(async input => {releaseAudio(); await framesStarted; return originalAudio(input);});
    t.processing.frames.mockImplementation(async input => {releaseFrames(); await audioStarted; return originalFrames(input);});
    t.providers.openaiFetch.mockImplementation(async () => ({ok: true, headers: {get: () => null}, text: async () => JSON.stringify({text: 'The city is Paris.'})}));
    const originalMessage = t.providers.anthropicCreateMessage.getMockImplementation();
    t.providers.anthropicCreateMessage.mockImplementation(async (body, options) => {
      const content = body.messages[0].content;
      if (typeof content !== 'string') return originalMessage(body, options);
      const evidence = JSON.parse(content.split('\nEvidence: ')[1]);
      const audio = evidence.find(e => e.modality === 'transcript'), visual = evidence.find(e => e.modality === 'visual');
      expect(audio).toBeDefined(); expect(visual.evidenceId).toMatch(/:obs:0$/);
      return message({places: [{name: 'Visual Cafe', city: 'Paris', evidenceRefs: [ref(visual.evidenceId, 'Visual Cafe', 'name'), ref(audio.evidenceId, 'Paris', 'city')]}], contradictions: []});
    });
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['combined']});
    expect(p.results[0].failure).toBeNull(); expect(p.results[0].candidates).toHaveLength(1);
    expect(p.results[0].candidates[0].nameRefs[0]).toMatchObject({modality: 'frame', intervalMs: [1000, 1000]});
    expect(p.results[0].candidates[0].branchRefs[0]).toMatchObject({modality: 'audio', intervalMs: [0, 20000]});
    expect(t.processing.probe).toHaveBeenCalledTimes(1); expect(t.processing.decode).toHaveBeenCalledTimes(1);
    expect(t.providers.anthropicCreateMessage.mock.calls.filter(([b]) => typeof b.messages[0].content === 'string')).toHaveLength(1);
    expect(validatePredictions(p, t.f.corpus, t.f.seal)).toBe(p);
  });
  test('a grounded explicit contradiction downgrades the prior baseline without deleting it or pretending a save occurred', async () => {
    const baseline = t.f.recordings.cases[0].responses.baseline;
    const caption = t.part.row.assets[0], bytes = Buffer.from(`${t.part.name} Paris. ${baseline.text}`);
    Object.assign(caption, {sha256: hash(bytes), byteLength: bytes.length, textLength: bytes.toString().length});
    fs.writeFileSync(path.join(dir, `${caption.sha256}.bin`), bytes);
    t.part.row.evidenceSha256 = checksum(t.part.row.assets); t.f.seal = sealCorpus(t.f.corpus);
    t.options.inputs = createReplayInputs(t.f.corpus, t.f.seal, 'holdout');
    t.f.recordings.inputsSha256 = checksum(t.options.inputs); t.f.places.inputsSha256 = checksum(t.options.inputs);
    baseline.text = bytes.toString();
    baseline.observations = [{query: `${t.part.name} Paris`, name: t.part.name, city: 'Paris', country: null, address: null,
      nameRefs: [t.part.captionRef], branchRefs: [t.part.captionRef], requiresSelection: false}];
    const denial = `We are not at ${t.part.name}.`;
    t.providers.openaiFetch.mockImplementation(async () => ({ok: true, headers: {get: () => null}, text: async () => JSON.stringify({text: denial})}));
    t.providers.anthropicCreateMessage.mockImplementation(async body => {
      const content = body.messages[0].content, evidence = JSON.parse(content.split('\nEvidence: ')[1]);
      const hypotheses = JSON.parse(content.split('Baseline context (not evidence): ')[1].split('\nEvidence: ')[0]);
      expect(hypotheses[0].name).toBe(t.part.name);
      expect(evidence.every(e => e.modality !== 'baseline')).toBe(true);
      return message({places: [], contradictions: [{name: t.part.name, evidenceRefs: [{evidenceId: evidence.find(e => e.modality === 'transcript').evidenceId, quote: denial}]}]});
    });
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [before, after] = await replayMultimodal({...t.options, stages, arms: ['baseline', 'audio']});
    expect(before.results[0].automaticDecisions).toHaveLength(1);
    expect(after.results[0].failure).toBeNull(); expect(after.results[0].candidates).toHaveLength(1);
    expect(after.results[0].candidates[0].requiresSelection).toBe(true); expect(after.results[0].automaticDecisions).toEqual([]);
    expect(after.results[0].autoSaved).toEqual([]); expect(after.results[0].confirmedSaved).toEqual([]);
  });
  test.each([3, 9])('%i frames use the shipped bounded batching policy, with one final fusion', async count => {
    t.processing.frames.mockImplementation(async ({media}) => ({frames: Array.from({length: count}, (_, i) => {
      const bytes = Buffer.concat([png, Buffer.from(`synthetic-frame-${i}`)]);
      return {bytes, digest: hash(bytes), sourceDigest: media.contentDigest, width: 1, height: 1, timestampMs: 1000 + i, crop: [0, 0, 1, 1]};
    })}));
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['frames']});
    expect(p.results[0].failure).toBeNull(); expect(p.results[0].analysis.frames.observedRefs).toHaveLength(count);
    const visionCalls = t.providers.anthropicCreateMessage.mock.calls.filter(([b]) => Array.isArray(b.messages[0].content));
    expect(visionCalls).toHaveLength(count <= 8 ? 1 : 2);
    expect(visionCalls.every(([b]) => b.messages[0].content.filter(c => c.type === 'image').length <= 8)).toBe(true);
    expect(t.providers.anthropicCreateMessage.mock.calls.filter(([b]) => typeof b.messages[0].content === 'string')).toHaveLength(1);
  });
  test('runtime citations fail closed if a provider invents a source ID or quote', async () => {
    t.providers.anthropicCreateMessage.mockImplementation(async () => message({places: [{name: t.part.name, evidenceRefs: [ref('audio:invented', t.part.name, 'name')]}]}));
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['audio']});
    expect(p.results[0].candidates).toEqual([]); expect(p.results[0].failure).toBe('stage_failed');
    expect(p.results[0].analysis.audio.status).toBe('complete'); // ASR succeeded; fusion did not.
    expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
  });
  test('asset/probe duration mismatch stops before any paid-provider boundary', async () => {
    t.processing.probe.mockImplementation(async () => ({durationMs: 31000, hasAudio: true}));
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['audio']});
    expect(p.results[0].failure).toBe('stage_failed'); expect(t.providers.openaiFetch).not.toHaveBeenCalled();
  });
  test('dismissal drains parallel work, prevents later dispatch/retries and removes owned files', async () => {
    const controller = new AbortController();
    // Frames may already be decoding in parallel when ASR is dismissed. They
    // must settle before cleanup and must never dispatch after the dismissal.
    const prepare = t.processing.frames.getMockImplementation();
    t.processing.frames.mockImplementation(async input => {await new Promise(resolve => setImmediate(resolve)); return prepare(input);});
    t.providers.openaiFetch.mockImplementation(async () => {controller.abort(); return {ok: true, headers: {get: () => null}, text: async () => JSON.stringify({text: t.part.name})};});
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const [p] = await replayMultimodal({...t.options, stages, arms: ['combined'], signal: controller.signal});
    expect(p.results[0].candidates).toEqual([]); expect(p.results[0].failure).toBe('cancelled');
    expect(t.providers.anthropicCreateMessage).not.toHaveBeenCalled(); expect(t.providers.openaiFetch).toHaveBeenCalledTimes(1);
    expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
  });
  test('registration cannot be directly dispatched or smuggled into offline mode as live', async () => {
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    await expect(stages.audio({})).rejects.toThrow('cancelled');
    const live = createRuntimeReplayAdapters({transport: 'live', processing: t.processing});
    await expect(replayMultimodal({...t.options, stages: live, arms: ['audio']})).rejects.toThrow('authorized permitted');
    await expect(replayMultimodal({...t.options, stages: live, arms: ['audio'], mode: 'live', liveAuthorization: {allowPaidInference: true, permittedInputsSha256: '0'.repeat(64), credentialSource: 'server_environment', runId: randomUUID()}})).rejects.toThrow('permitted');
    expect(t.providers.openaiFetch).not.toHaveBeenCalled(); expect(t.processing.probe).not.toHaveBeenCalled();
  });
  test('cancelled A cannot dispatch, publish or charge B when its detached producer settles during B', async () => {
    const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
    const aStarted = deferred(), bStarted = deferred(), aResponse = deferred(), bResponse = deferred();
    const callbacks = [], validators = [];
    const service = require('../lib/media/transcriptionService'), makeService = service.createTranscriptionService;
    const serviceSpy = jest.spyOn(service, 'createTranscriptionService').mockImplementation(deps => {
      callbacks.push(deps.providerCall); return makeService(deps);
    });
    const decode = t.processing.decode.getMockImplementation();
    t.processing.decode.mockImplementation(async input => {validators.push(jobContext.current().validateProviderDispatch); return (await decode(input)).slice(0, 1);});
    const response = text => ({ok: true, headers: {get: () => null}, text: async () => JSON.stringify({text,
      usage: {type: 'tokens', input_tokens: text.startsWith('A_') ? 9999 : 12, output_tokens: 1,
        input_token_details: {audio_tokens: text.startsWith('A_') ? 9999 : 12, text_tokens: 0}}})});
    t.providers.openaiFetch.mockImplementationOnce(async () => {aStarted.resolve(); return aResponse.promise;})
      .mockImplementationOnce(async () => {bStarted.resolve(); return bResponse.promise;})
      .mockImplementation(async () => response('B_ONLY Cafe Paris'));
    t.providers.anthropicCreateMessage.mockImplementation(async body => {
      const evidence = JSON.parse(body.messages[0].content.split('\nEvidence: ')[1]);
      expect(evidence.some(e => e.text.includes('A_ONLY'))).toBe(false);
      const audio = evidence.find(e => e.modality === 'transcript');
      return message({places: [{name: 'B_ONLY Cafe', city: 'Paris', evidenceRefs: [ref(audio.evidenceId, 'B_ONLY Cafe', 'name'), ref(audio.evidenceId, 'Paris', 'city')]}], contradictions: []});
    });
    const stages = createRuntimeReplayAdapters({providers: t.providers, processing: t.processing});
    const runtime = registeredRuntimeAdapters(stages), controller = new AbortController();
    const assets = t.part.row.assets.map(a => ({...a, bytes: fs.readFileSync(path.join(dir, `${a.sha256}.bin`))}));
    const context = {assets, assetDescriptors: t.part.row.assets, recordedResponse: t.f.recordings.cases[0].responses.baseline};
    runtime.authorize({mode: 'offline', inputs: t.options.inputs, liveAuthorization: null});
    let pendingA, pendingB;
    try {
      runtime.beginCase({caseId: 'A', platform: 'instagram', language: 'en', signal: controller.signal});
      await stages.baseline(context);
      pendingA = stages.audio(context).catch(error => error);
      await aStarted.promise;
      controller.abort(); expect(await pendingA).toBeInstanceOf(Error);
      const reportA = await runtime.finishCase({failure: 'cancelled'}), sealedA = JSON.stringify(reportA);
      expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
      const aMedia = reportA.at(-1);
      expect(aMedia.providerCalls).toHaveLength(1);
      expect(aMedia.providerCalls[0].outcome).toBe('cancelled');
      expect(aMedia.estimatedCost).toMatchObject({totalUsd: null, complete: false, observedCalls: 1, unknownCalls: 1});

      runtime.beginCase({caseId: 'B', platform: 'instagram', language: 'en'});
      const baseline = await stages.baseline(context);
      pendingB = stages.audio(context);
      await bStarted.promise; // A's physical transport is STILL pending here.
      const authorize = jest.fn(), lateSpend = jest.fn();
      await expect(validators[0]()).rejects.toThrow('cancelled');
      await expect(jobContext.run({sharedOperation: {kind: 'asr_chunk', authorizeDispatch: authorize}},
        () => callbacks[0]('openai', lateSpend, 1, {stage: 'transcription'}))).rejects.toThrow('cancelled');
      expect(authorize).not.toHaveBeenCalled(); expect(lateSpend).not.toHaveBeenCalled();
      aResponse.resolve(response('A_ONLY venue with 9999 tokens'));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(JSON.stringify(reportA)).toBe(sealedA);
      expect(t.providers.openaiFetch).toHaveBeenCalledTimes(2); // no A chunk two/restart.
      bResponse.resolve(response('B_ONLY Cafe Paris'));
      const audio = await pendingB;
      const fused = await stages.fuse({baseline, pieces: [baseline, audio]});
      expect(audio.text).not.toContain('A_ONLY'); expect(fused.observations.map(p => p.name)).toEqual(['B_ONLY Cafe']);
      const reportB = await runtime.finishCase({failure: null}), bMedia = reportB.at(-1);
      expect(bMedia.providerCalls.map(c => c.stage)).toEqual(['transcription', 'media_fusion']);
      expect(bMedia.providerCalls.filter(c => c.provider === 'openai').every(c => c.tokens.audioInput === 12)).toBe(true);
      expect(t.providers.openaiFetch).toHaveBeenCalledTimes(2); expect(t.providers.anthropicCreateMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(reportA)).toBe(sealedA);
      expect(t.paths.every(p => !fs.existsSync(p))).toBe(true);
    } finally {
      controller.abort(); aResponse.resolve(response('A_ONLY late')); bResponse.resolve(response('B_ONLY Cafe Paris'));
      await runtime.close(); await Promise.allSettled([pendingA, pendingB]); serviceSpy.mockRestore();
    }
  });
});
describe('shipped selective policy and evidence bridge', () => {
  test('policy uses actual captured caption/subtitle text and frozen matches, ignoring recording flags and invented text', () => {
    const name = 'Known Cafe', caption = `Known Cafe in Paris. ${'An actual long description of this restaurant in Paris. '.repeat(3)}`;
    const baseline = {text: 'Top 9 secret restaurants', needsMoreEvidence: true, observations: [{name, city: 'Paris', query: 'Known Cafe Paris', requiresSelection: false}]};
    const context = {caseId: 'case', platform: 'instagram', baseline, assets: [{kind: 'video'}, {kind: 'caption', bytes: Buffer.from(caption)}, {kind: 'subtitles', bytes: Buffer.from('Known Cafe Paris')}],
      places: {entries: [{caseId: 'case', query: 'Known Cafe Paris', results: [{place_id: 'one', name, formatted_address: 'Paris', lat: 1, lng: 1}]}]}};
    expect(selectiveDecision(context)).toEqual({audio: false, frames: false});
    context.baseline.needsMoreEvidence = false; context.assets[1].bytes = Buffer.from(`Top 5 restaurants in Paris. ${caption}`);
    expect(selectiveDecision(context)).toEqual({audio: true, frames: true});
    context.assets[1].bytes = Buffer.from(caption); context.assets = context.assets.filter(a => a.kind !== 'subtitles');
    expect(selectiveDecision(context)).toEqual({audio: true, frames: true});
    context.platform = 'web'; expect(selectiveDecision(context)).toEqual({audio: false, frames: false});
  });
  test('bridge binds hashes and chunk windows, narrows literal caption offsets, transforms crop coordinates', () => {
    const f = fixture(), part = f.selected[1], video = {...part.row.assets[1], bytes: f.files.get(part.row.assets[1].sha256)}, caption = {...part.row.assets[0], bytes: f.files.get(part.row.assets[0].sha256)};
    const bridge = createCaptureEvidenceBridge(part.row.assets), text = bridge.addText(caption);
    expect(bridge.reference(ref(text.evidenceId, 'Paris', 'city')).textRange).toEqual([caption.textLength - 5, caption.textLength]);
    const frame = {bytes: png, digest: hash(png), sourceDigest: video.sha256, timestampMs: 12345, crop: [.2, .2, .8, .8]}; bridge.addFrames([frame], video);
    const mapped = bridge.reference(ref(`frame:${frame.digest}:12345`, 'Sign', 'name', {region: [0, 0, .5, .5]}));
    expect(mapped.intervalMs).toEqual([12345, 12345]); expect(mapped.region).toEqual([.2, .2, .5, .5]);
    expect(() => bridge.addFrames([{...frame, timestampMs: 100, digest: '0'.repeat(64)}], video)).toThrow('binding');
    expect(() => bridge.reference(ref('unknown', 'Paris', 'city'))).toThrow('binding');
    const bytes = Buffer.from('RIFF0000WAVEsample'), sha = hash(bytes), chunk = {audioBytes: bytes, audioSha256: sha, startMs: 1000, endMs: 2000};
    bridge.addTranscript({mediaDigest: video.sha256, segments: [{origin: 'audio', evidenceId: `audio:${sha}:1000:0`, audioSha256: sha, startMs: 1000.125, endMs: 1999.875, text: 'A real phrase'}]}, [chunk], video);
    expect(bridge.reference(ref(`audio:${sha}:1000:0`, 'real phrase', 'name')).intervalMs).toEqual([1000, 2000]);
    expect(() => bridge.reference(ref(`audio:${sha}:1000:0`, 'invented', 'name'))).toThrow('binding');
    const repeated = {...chunk, startMs: 3000, endMs: 4000};
    bridge.addTranscript({mediaDigest: video.sha256, segments: [{origin: 'audio', evidenceId: `audio:${sha}:3000:0`, audioSha256: sha, startMs: 3000, endMs: 4000, text: 'A repeated phrase'}]}, [chunk, repeated], video);
    expect(bridge.reference(ref(`audio:${sha}:3000:0`, 'repeated', 'name')).intervalMs).toEqual([3000, 4000]);
    const [visual] = bridge.addVisualObservations([{evidenceId: `frame:${frame.digest}:12345`, quote: 'Sign in Paris', region: [0, 0, .5, .5]}]);
    expect(bridge.reference(ref(visual.evidenceId, 'Paris', 'city'))).toMatchObject({modality: 'frame', intervalMs: [12345, 12345], region: [.2, .2, .5, .5]});
    expect(() => bridge.reference(ref(visual.evidenceId, 'invented', 'name'))).toThrow('binding');
  });
});
