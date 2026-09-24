'use strict';
const {checksum, identity, verifySeal} = require('./labeledEvaluationSchema');
const {exact, list, UUID, SHA, date, venues, refs} = require('./labeledEvaluationSchemaV2');
const ARMS = Object.freeze(['baseline', 'audio', 'frames', 'combined', 'selective']);
const EXECUTIONS = ['recorded_replay', 'captured_inference', 'isolated_tester'];
const fail = message => {throw new Error(message);};
const emptyCoverage = () => ({status: 'unattempted', plannedRefs: [], observedRefs: [], reason: null});
/** Cover only the planned policy. `complete` means every requested unit was
 * read, NEVER that every venue in a video was found. Actual reference bounds are
 * checked against the captured assets; omitted policy units cannot be invented. */
function validateAnalysis(value, assets) {
  exact(value, ['audio', 'frames'], 'analysis coverage');
  for (const kind of ['audio', 'frames']) {
    const c = value[kind]; exact(c, ['status', 'plannedRefs', 'observedRefs', 'reason'], 'modality coverage');
    if (!['unattempted', 'unavailable', 'failed', 'partial', 'complete'].includes(c.status) || (c.reason !== null && (typeof c.reason !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(c.reason)))) fail('Invalid coverage state/reason');
    refs(c.plannedRefs, assets); refs(c.observedRefs, assets);
    const planned = new Set(c.plannedRefs.map(checksum));
    if (c.observedRefs.some(r => !planned.has(checksum(r)))) fail('Observed evidence was not planned');
    const n = c.plannedRefs.length, read = c.observedRefs.length;
    if ((c.status === 'unattempted' && (n || read || c.reason !== null)) || (c.status === 'complete' && (!n || read !== n || c.reason !== null)) || (c.status === 'partial' && (!read || read >= n || !c.reason)) || (['unavailable', 'failed'].includes(c.status) && (read || !c.reason))) fail('False complete or inconsistent coverage');
    for (const r of c.plannedRefs) {
      if (kind === 'audio' && r.modality !== 'audio') fail('Audio coverage references non-audio media');
      if (kind === 'frames' && (r.modality !== 'frame' || (r.intervalMs && r.intervalMs[0] !== r.intervalMs[1]))) fail('Frame coverage requires a captured frame timestamp');
    }
  }
  return value;
}
function contains(outer, inner) {
  if (outer.assetId !== inner.assetId || outer.modality !== inner.modality) return false;
  return ['intervalMs', 'textRange'].every(k => outer[k] === null ? inner[k] === null : inner[k] !== null && outer[k][0] <= inner[k][0] && outer[k][1] >= inner[k][1])
    && (outer.region === null || (inner.region !== null && outer.region[0] <= inner.region[0] && outer.region[1] <= inner.region[1] && outer.region[2] >= inner.region[2] && outer.region[3] >= inner.region[3]));
}
function validateCandidates(candidates, assets, analysis) {
  list(candidates, 40, 'proposed candidates'); const seen = new Set();
  for (const c of candidates) {
    exact(c, ['venueId', 'branchId', 'nameRefs', 'branchRefs', 'requiresSelection'], 'proposed candidate');
    venues([{venueId: c.venueId, branchId: c.branchId}]);
    if (seen.has(identity(c)) || typeof c.requiresSelection !== 'boolean') fail('Invalid/duplicate candidate');
    refs(c.nameRefs, assets); refs(c.branchRefs, assets); // Empty support is scored as unsupported, never hidden.
    for (const r of [...c.nameRefs, ...c.branchRefs]) {
      const a = assets.find(a => a.assetId === r.assetId);
      if (['audio', 'video', 'image'].includes(a.kind) && ![...analysis.audio.observedRefs, ...analysis.frames.observedRefs].some(o => contains(o, r))) fail('Candidate cites unobserved media');
    }
    seen.add(identity(c));
  }
}
function validateVersions(v) {
  exact(v, ['engine', 'prompt', 'model', 'sampling', 'adapter'], 'recorded versions');
  if (Object.values(v).some(s => typeof s !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(s))) fail('Invalid recorded version');
}
/** v2 separates candidates, offline automatic decisions, and REAL saves. No
 * offline simulation may masquerade as a tester confirmation or persisted pin.
 * Metrics remain the engineMetrics contract, not an evaluation price table. */
function validatePredictionsV2(p, corpus, manifest) {
  verifySeal(corpus, manifest);
  exact(p, ['schemaVersion', 'corpusSha256', 'mode', 'split', 'authorizedLiveRetrieval', 'arm', 'execution', 'versions', 'cacheState', 'frozenPlacesSha256', 'results', ...(Object.hasOwn(p, 'timing') ? ['timing'] : [])], 'v2 predictions');
  // Older v2 files may omit timing. Neither absence nor replay milliseconds
  // establish actual deployment p95. No producer can opt itself into that gate.
  if (Object.hasOwn(p, 'timing') && p.timing !== 'diagnostic_non_production') fail('Replay timing is diagnostic, not deployment latency');
  if (p.schemaVersion !== 2 || p.corpusSha256 !== manifest.corpusSha256 || !ARMS.includes(p.arm) || !EXECUTIONS.includes(p.execution) || !['cold', 'warm'].includes(p.cacheState) || typeof p.frozenPlacesSha256 !== 'string' || !SHA.test(p.frozenPlacesSha256) || !['development', 'holdout'].includes(p.split) || !['captured_evidence', 'authorized_live_retrieval'].includes(p.mode)) fail('Invalid predictions version/corpus/mode');
  validateVersions(p.versions);
  const live = p.mode === 'authorized_live_retrieval';
  if (p.authorizedLiveRetrieval !== live) fail('Live retrieval requires explicit authorization');
  const selected = corpus.cases.filter(c => c.split === p.split), byId = new Map(selected.map(c => [c.caseId, c]));
  list(p.results, 10000, 'prediction results');
  if (!selected.length || p.results.length !== selected.length) fail('Every split case requires exactly one result');
  const seen = new Set(), reports = new Set();
  for (const r of p.results) {
    exact(r, ['caseId', 'evidenceSha256', 'sourceStatus', 'candidates', 'automaticDecisions', 'autoSaved', 'confirmedSaved', 'saveAttestation', 'requiresConfirmation', 'partial', 'analysis', 'attemptMetrics', 'failure'], 'v2 prediction result');
    const row = byId.get(r.caseId);
    if (!row || seen.has(r.caseId) || r.evidenceSha256 !== row.evidenceSha256) fail('Unknown/duplicate case or evidence checksum mismatch');
    if (!(live ? ['accessible', 'blocked', 'rate_limited', 'unavailable'] : ['captured']).includes(r.sourceStatus)) fail('Source status disagrees with evaluation mode');
    if (typeof r.requiresConfirmation !== 'boolean' || typeof r.partial !== 'boolean' || (r.failure !== null && !['recording_missing', 'stage_failed', 'cancelled', 'deadline', 'source_unavailable'].includes(r.failure))) fail('Invalid result flags/failure');
    validateAnalysis(r.analysis, row.assets); validateCandidates(r.candidates, row.assets, r.analysis);
    if ((r.analysis.audio.status === 'partial' || r.analysis.frames.status === 'partial' || ['failed', 'unavailable'].includes(r.analysis.audio.status) || ['failed', 'unavailable'].includes(r.analysis.frames.status)) && !r.partial) fail('Incomplete analysis cannot claim a complete result');
    venues(r.automaticDecisions); venues(r.autoSaved, true); venues(r.confirmedSaved, true);
    const proposed = new Map(r.candidates.map(c => [identity(c), c])), decisions = new Set(r.automaticDecisions.map(identity));
    if (r.automaticDecisions.some(v => !proposed.has(identity(v)) || proposed.get(identity(v)).requiresSelection) || r.autoSaved.some(v => !decisions.has(identity(v))) || r.confirmedSaved.some(v => !proposed.has(identity(v)))) fail('Save/decision absent from eligible proposed candidates');
    const saved = [...r.autoSaved, ...r.confirmedSaved];
    if (new Set(saved.map(identity)).size !== saved.length) fail('Duplicate actual save');
    if (p.execution !== 'isolated_tester' && (saved.length || r.saveAttestation !== null)) fail('Replay/inference cannot claim actual saves');
    if (saved.length) {
      exact(r.saveAttestation, ['environment', 'testerId', 'recordedAt'], 'actual save attestation');
      if (r.saveAttestation.environment !== 'isolated_test' || typeof r.saveAttestation.testerId !== 'string' || !UUID.test(r.saveAttestation.testerId) || !date(r.saveAttestation.recordedAt)) fail('Actual saves need isolated tester attestation');
    } else if (r.saveAttestation !== null) fail('Save attestation without saves');
    if (live && (r.candidates.length || saved.length || decisions.size || r.requiresConfirmation || r.partial || Object.values(r.analysis).some(c => c.status !== 'unattempted'))) fail('Live retrieval measures accessibility only');
    list(r.attemptMetrics, 100, 'attempt metrics');
    for (const m of r.attemptMetrics) {
      if (!m || reports.has(m.reportId) || m.platform !== row.platform || m.language !== row.language) fail('Duplicate or misattributed attempt metrics');
      reports.add(m.reportId);
    }
    seen.add(r.caseId);
  }
  return p;
}
/** Semantic scoring only: a ref must overlap an independently annotated clue.
 * Coverage alone does not prove a spoken phrase identifies the chosen branch. */
function overlaps(a, b) {
  if (a.assetId !== b.assetId || a.modality !== b.modality) return false;
  for (const key of ['intervalMs', 'textRange']) {
    if ((a[key] === null) !== (b[key] === null)) return false;
    if (a[key] !== null) {
      const [x, y] = a[key], [u, v] = b[key];
      if (key === 'textRange' ? x >= v || u >= y : x > v || u > y || (x !== y && u !== v && (x === v || u === y))) return false;
    }
  }
  if (a.region && b.region && (a.region[0] >= b.region[2] || b.region[0] >= a.region[2] || a.region[1] >= b.region[3] || b.region[1] >= a.region[3])) return false;
  return true;
}
module.exports = {ARMS, EXECUTIONS, emptyCoverage, validateAnalysis, validateCandidates, validateVersions, validatePredictionsV2, overlaps, contains};
