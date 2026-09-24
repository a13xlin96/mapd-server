'use strict';
// A label-blind, read-only prediction producer. This module never imports the
// job runner, Firestore, server entry point or production saves. Only trusted
// registered runtime adapters can opt into local inference/provider clients.
const fs = require('fs');
const path = require('path');
const {createHash} = require('crypto');
const {checksum, verifySeal, identity} = require('./labeledEvaluationSchema');
const {exact, list, UUID, SHA, validateAssets, verifyAssetRows, refs} = require('./labeledEvaluationSchemaV2');
const {ARMS, emptyCoverage, validateAnalysis, validateCandidates, validateVersions} = require('./labeledPredictionV2');
const {rankPlaces} = require('../enrich/confidence');
const {PLATFORMS, LANGUAGES, summarizeMetrics} = require('./engineMetrics');
const {selectiveDecision} = require('./runtimeReplayPolicy');
const fail = message => {throw new Error(message);};
const clone = value => JSON.parse(JSON.stringify(value));

/** Run only in the private importer: explicitly project away labels, supports,
 * family/group identities, dispositions, coverage tags and verifier metadata.
 * The producer takes this exported document, never a corpus or answer file. */
function createReplayInputs(corpus, seal, split = 'development') {
  verifySeal(corpus, seal);
  if (corpus.schemaVersion !== 2 || !['development', 'holdout'].includes(split)) fail('Replay requires a v2 captured corpus split');
  const input = {schemaVersion: 2, corpusSha256: seal.corpusSha256, split,
    cases: corpus.cases.filter(r => r.split === split).map(r => ({caseId: r.caseId, platform: r.platform, language: r.language, evidenceSha256: r.evidenceSha256, assets: clone(r.assets)}))};
  return validateInputs(input);
}
function validateInputs(input) {
  exact(input, ['schemaVersion', 'corpusSha256', 'split', 'cases'], 'label-blind replay input');
  if (input.schemaVersion !== 2 || typeof input.corpusSha256 !== 'string' || !SHA.test(input.corpusSha256) || !['development', 'holdout'].includes(input.split)) fail('Invalid replay input version/checksum');
  list(input.cases, 10000, 'replay cases'); if (!input.cases.length) fail('Empty replay split');
  const seen = new Set();
  for (const c of input.cases) {
    exact(c, ['caseId', 'platform', 'language', 'evidenceSha256', 'assets'], 'label-blind replay case');
    validateAssets(c.assets);
    if (typeof c.caseId !== 'string' || !UUID.test(c.caseId) || seen.has(c.caseId.toLowerCase()) || !PLATFORMS.includes(c.platform) || !LANGUAGES.includes(c.language) || c.evidenceSha256 !== checksum(c.assets)) fail('Invalid replay case identity');
    seen.add(c.caseId.toLowerCase());
  }
  return input;
}
function validatePlaces(places, inputs) {
  exact(places, ['schemaVersion', 'inputsSha256', 'entries'], 'frozen Places responses');
  if (places.schemaVersion !== 2 || places.inputsSha256 !== checksum(inputs)) fail('Frozen Places/input checksum mismatch');
  list(places.entries, 100000, 'frozen Places entries'); const keys = new Set();
  for (const e of places.entries) {
    exact(e, ['caseId', 'query', 'results'], 'frozen Places query');
    if (!inputs.cases.some(c => c.caseId === e.caseId) || typeof e.query !== 'string' || !e.query.length || e.query.length > 1000) fail('Invalid frozen Places query');
    const key = checksum([e.caseId, e.query]); if (keys.has(key)) fail('Duplicate frozen query'); keys.add(key);
    list(e.results, 20, 'frozen places'); const ids = new Set();
    for (const r of e.results) {
      exact(r, ['place_id', 'name', 'formatted_address', 'lat', 'lng', 'venueId', 'branchId'], 'frozen Place');
      for (const field of ['place_id', 'name', 'formatted_address', 'venueId', 'branchId']) if (typeof r[field] !== 'string' || !r[field].length || r[field].length > 1000) fail('Invalid frozen Place field');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(r.venueId) || !/^[A-Za-z0-9_-]{1,128}$/.test(r.branchId) || ids.has(r.place_id) || !Number.isFinite(r.lat) || Math.abs(r.lat) > 90 || !Number.isFinite(r.lng) || Math.abs(r.lng) > 180) fail('Invalid frozen Place identity/coordinates');
      ids.add(r.place_id);
    }
  }
  return places;
}
/** A recorded stage is normalized provider output, not a hand-written gold
 * transcript: {text,observations,needsMoreEvidence,coverage}. Observations carry
 * query,name,city,address,country,nameRefs,branchRefs,requiresSelection. */
function validateStage(stage, kind, assets) {
  exact(stage, ['text', 'observations', 'needsMoreEvidence', 'coverage'], 'recorded stage');
  if (typeof stage.text !== 'string' || Buffer.byteLength(stage.text) > 65536 || typeof stage.needsMoreEvidence !== 'boolean') fail('Invalid recorded stage text/policy');
  list(stage.observations, 40, 'stage observations');
  for (const o of stage.observations) {
    exact(o, ['query', 'name', 'city', 'address', 'country', 'nameRefs', 'branchRefs', 'requiresSelection'], 'observation');
    if (typeof o.query !== 'string' || !o.query.length || o.query.length > 1000 || typeof o.name !== 'string' || !o.name.length || o.name.length > 300 || typeof o.requiresSelection !== 'boolean') fail('Invalid observation');
    if (['city', 'address', 'country'].some(k => o[k] !== null && (typeof o[k] !== 'string' || o[k].length > 1000))) fail('Invalid observation location');
    refs(o.nameRefs, assets); refs(o.branchRefs, assets);
  }
  if (kind === 'baseline') {if (stage.coverage !== null) fail('Baseline has no media coverage');}
  else validateAnalysis({audio: emptyCoverage(), frames: emptyCoverage(), [kind]: stage.coverage}, assets);
  return stage;
}
function validateRecordings(recordings, inputs) {
  exact(recordings, ['schemaVersion', 'inputsSha256', 'versions', 'cacheState', 'cases'], 'recorded responses');
  if (recordings.schemaVersion !== 2 || recordings.inputsSha256 !== checksum(inputs) || !['cold', 'warm'].includes(recordings.cacheState)) fail('Recorded input checksum/cache mismatch');
  validateVersions(recordings.versions); list(recordings.cases, inputs.cases.length, 'recorded cases');
  const seen = new Set();
  for (const r of recordings.cases) {
    exact(r, ['caseId', 'responses', 'metricsByArm'], 'recorded case');
    const c = inputs.cases.find(c => c.caseId === r.caseId);
    if (!c || seen.has(r.caseId)) fail('Unknown/duplicate recorded case'); seen.add(r.caseId);
    exact(r.responses, ['baseline', 'audio', 'frames'], 'recorded stage responses');
    for (const k of ['baseline', 'audio', 'frames']) if (r.responses[k] !== null) validateStage(r.responses[k], k, c.assets);
    exact(r.metricsByArm, ARMS, 'arm measurements');
    for (const arm of ARMS) {
      list(r.metricsByArm[arm], 100, 'recorded arm metrics');
      if (r.metricsByArm[arm].some(m => m.platform !== c.platform || m.language !== c.language)) fail('Misattributed recorded observations');
      summarizeMetrics(r.metricsByArm[arm]);
    }
  }
  return recordings;
}
function mergePieces(pieces) {
  const queries = new Map();
  for (const p of pieces) for (const o of p.observations) {
    const previous = queries.get(o.query);
    if (!previous) queries.set(o.query, clone(o));
    else {
      for (const k of ['nameRefs', 'branchRefs']) previous[k] = [...new Map([...previous[k], ...o[k]].map(r => [checksum(r), r])).values()];
      previous.requiresSelection ||= o.requiresSelection;
    }
  }
  return {text: pieces.map(p => p.text).join('\n'), observations: [...queries.values()]};
}
/** Default matching uses the shipped ranker over frozen normalized Places
 * responses. No Google call, save operation or simulation of user selection. */
function matchFrozen({caseId, evidence, places, mediaUsed}) {
  const matched = new Map();
  for (const o of evidence.observations) {
    const frozen = places.entries.find(e => e.caseId === caseId && e.query === o.query);
    if (!frozen) fail('Missing frozen Places response'); // Not a confident no-place outcome.
    const rank = rankPlaces(frozen.results, {description: evidence.text}, {...o, source: 'caption'});
    if (!rank.place) continue;
    const c = {venueId: rank.place.venueId, branchId: rank.place.branchId, nameRefs: o.nameRefs, branchRefs: o.branchRefs,
      requiresSelection: mediaUsed || rank.requiresSelection || o.requiresSelection};
    const prior = matched.get(identity(c));
    if (!prior) matched.set(identity(c), c);
    else {
      for (const k of ['nameRefs', 'branchRefs']) prior[k] = [...new Map([...prior[k], ...c[k]].map(r => [checksum(r), r])).values()];
      prior.requiresSelection ||= c.requiresSelection;
    }
  }
  return [...matched.values()];
}
function loadAssets(row, directory, kind) {
  const allowed = kind === 'baseline' ? ['caption', 'subtitles'] : kind === 'audio' ? ['audio', 'video'] : ['image', 'video'];
  return row.assets.filter(a => allowed.includes(a.kind)).map(a => {
    const fd = fs.openSync(path.join(directory, `${a.sha256}.bin`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      if (fs.fstatSync(fd).size !== a.byteLength) fail('Asset changed after verification');
      bytes = Buffer.alloc(a.byteLength); let offset = 0, n;
      while (offset < bytes.length && (n = fs.readSync(fd, bytes, offset, bytes.length - offset, null))) offset += n;
      if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== a.sha256) fail('Asset changed after verification');
    } finally {fs.closeSync(fd);}
    return {...clone(a), bytes};
  });
}
/** Execute all requested arms on identical captures. Injectable functions are
 * trusted in-process adapters, never JS/module names from CLI or JSON. No labels
 * enter any callback. mode=live requires explicit permission, a bound permitted
 * data digest, environment credential attestation AND injected provider stages;
 * runtimeReplayAdapters supplies the trusted local-capture implementation.
 * A caller-supplied signal can cancel work; no failures are requeued/retried. */
async function replayMultimodal({inputs, directory, recordings, places, arms = ARMS, mode = 'offline', liveAuthorization = null,
  stages = {}, signal, deadlineMs = null}) {
  validateInputs(inputs); validatePlaces(places, inputs); validateRecordings(recordings, inputs);
  if (!['offline', 'live'].includes(mode) || !Array.isArray(arms) || !arms.length || new Set(arms).size !== arms.length || arms.some(a => !ARMS.includes(a))) fail('Invalid replay mode/arms');
  if (Object.keys(stages).some(k => !['baseline', 'audio', 'frames', 'fuse', 'match', 'shouldEscalate'].includes(k)) || Object.values(stages).some(f => typeof f !== 'function')) fail('Invalid trusted replay adapters');
  if (mode === 'live') {
    exact(liveAuthorization, ['allowPaidInference', 'permittedInputsSha256', 'credentialSource', 'runId'], 'live authorization');
    if (liveAuthorization.allowPaidInference !== true || liveAuthorization.permittedInputsSha256 !== checksum(inputs) || liveAuthorization.credentialSource !== 'server_environment' || typeof liveAuthorization.runId !== 'string' || !UUID.test(liveAuthorization.runId) || ['baseline', 'audio', 'frames'].some(k => !stages[k])) fail('Live mode requires explicit permitted data, server credentials, run ID and trusted adapters');
  } else if (liveAuthorization !== null) fail('Offline replay cannot accept live authorization');
  if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) fail('Invalid replay deadline');
  verifyAssetRows(inputs.cases, directory);
  const registration = require('./runtimeReplayAdapters').registeredRuntimeAdapters(stages);
  registration?.authorize({mode, liveAuthorization, inputs});
  const check = () => {if (signal?.aborted) fail('cancelled'); if (deadlineMs !== null && Date.now() >= deadlineMs) fail('deadline');};
  const reports = [];
  try {
  for (const arm of arms) {
    const predictions = {schemaVersion: 2, corpusSha256: inputs.corpusSha256, mode: 'captured_evidence', split: inputs.split,
      authorizedLiveRetrieval: false, arm, execution: mode === 'live' ? 'captured_inference' : 'recorded_replay', timing: 'diagnostic_non_production', versions: clone(registration?.versions || recordings.versions), cacheState: recordings.cacheState, frozenPlacesSha256: checksum(places), results: []};
    for (const row of inputs.cases) {
      const recording = recordings.cases.find(r => r.caseId === row.caseId);
      const result = {caseId: row.caseId, evidenceSha256: row.evidenceSha256, sourceStatus: 'captured', candidates: [], automaticDecisions: [], autoSaved: [], confirmedSaved: [], saveAttestation: null,
        requiresConfirmation: false, partial: false, analysis: {audio: emptyCoverage(), frames: emptyCoverage()}, attemptMetrics: mode === 'offline' && !Object.keys(stages).length ? clone(recording?.metricsByArm[arm] || []) : [], failure: null};
      const piecesByKind = {};
      registration?.beginCase({caseId: row.caseId, arm, platform: row.platform, language: row.language, signal, deadlineMs,
        baselineMetrics: recording?.metricsByArm.baseline || []});
      const run = async kind => {
        try {
          check();
          const output = stages[kind] ? await stages[kind]({caseId: row.caseId, arm, platform: row.platform, language: row.language,
            assets: loadAssets(row, directory, kind), assetDescriptors: clone(row.assets), recordedResponse: clone(recording?.responses[kind] || null), signal, deadlineMs}) : recording?.responses[kind];
          check(); if (!output) fail('recording_missing');
          const validated = validateStage(clone(output), kind, row.assets);
          piecesByKind[kind] = validated;
          if (kind !== 'baseline') result.analysis[kind] = validated.coverage;
          return validated;
        } catch (error) {
          const reason = ['cancelled', 'deadline', 'recording_missing'].includes(error.message) ? error.message : error.code === 'attempt_stopped' ? 'cancelled' : error.code === 'dependency_timeout' ? 'deadline' : 'stage_failed';
          result.failure ||= reason; result.partial = true;
          if (kind !== 'baseline') result.analysis[kind] = {...emptyCoverage(), status: 'failed', reason};
          if (reason === 'cancelled' || reason === 'deadline') throw new Error(reason);
          return null;
        }
      };
      try {
        const baseline = await run('baseline');
        let audio = ['audio', 'combined'].includes(arm), frames = ['frames', 'combined'].includes(arm);
        if (arm === 'selective') {
          const capturedText = loadAssets(row, directory, 'baseline');
          const context = {caseId: row.caseId, platform: row.platform, baseline: clone(baseline),
            assets: row.assets.map(a => capturedText.find(t => t.assetId === a.assetId) || clone(a)),
            places: {...places, entries: places.entries.filter(e => e.caseId === row.caseId)}, signal, deadlineMs};
          const decision = await (stages.shouldEscalate || selectiveDecision)(context);
          exact(decision, ['audio', 'frames'], 'escalation decision');
          if (typeof decision.audio !== 'boolean' || typeof decision.frames !== 'boolean') fail('Invalid escalation decision');
          ({audio, frames} = decision);
        }
        const modalities = async () => {
          // Wait for every started task even on cancellation before disposing
          // its shared workspace. Never race cleanup against a still-live task.
          const outcomes = await Promise.allSettled([...(audio ? [run('audio')] : []), ...(frames ? [run('frames')] : [])]);
          const rejected = outcomes.find(o => o.status === 'rejected'); if (rejected) throw rejected.reason;
        };
        if (audio || frames) await (registration ? registration.runMediaPhase(modalities) : modalities());
        check();
        const pieces = ['baseline', 'audio', 'frames'].map(k => piecesByKind[k]).filter(Boolean);
        const evidence = stages.fuse ? await stages.fuse({caseId: row.caseId, arm, baseline: clone(baseline), pieces: clone(pieces), signal, deadlineMs}) : mergePieces(pieces);
        check();
        const context = {caseId: row.caseId, evidence, places: {...places, entries: clone(places.entries.filter(e => e.caseId === row.caseId))}, mediaUsed: audio || frames, signal, deadlineMs};
        result.candidates = stages.match ? await stages.match(context) : matchFrozen(context);
        check(); validateCandidates(result.candidates, row.assets, result.analysis);
        result.automaticDecisions = result.candidates.filter(c => !c.requiresSelection).map(c => ({venueId: c.venueId, branchId: c.branchId}));
        result.requiresConfirmation = result.candidates.some(c => c.requiresSelection);
        result.partial ||= Object.values(result.analysis).some(c => ['partial', 'failed', 'unavailable'].includes(c.status));
      } catch (error) {
        result.failure ||= ['cancelled', 'deadline'].includes(error.message) ? error.message : 'stage_failed'; result.partial = true;
        // A failed match/cancel never publishes a partly validated candidate set.
        result.candidates = []; result.automaticDecisions = []; result.requiresConfirmation = false;
      }
      if (registration) result.attemptMetrics = await registration.finishCase(result);
      predictions.results.push(result);
    }
    reports.push(predictions);
  }
  return reports;
  } finally {await registration?.close();}
}
module.exports = {createReplayInputs, validateInputs, validatePlaces, validateStage, validateRecordings, mergePieces, matchFrozen, replayMultimodal};
