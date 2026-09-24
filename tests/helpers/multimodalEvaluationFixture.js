'use strict';
// SYNTHETIC CONTRACT/SCORING DATA ONLY. The bytes below are not real recordings,
// independent labels, recognition benchmarks, or a release corpus.
const {randomUUID, createHash} = require('crypto');
const {checksum, sealCorpus} = require('../../lib/labeledEvaluationSchema');
const {createReplayInputs} = require('../../lib/multimodalReplay');
const {ARMS, emptyCoverage} = require('../../lib/labeledPredictionV2');
const hash = b => createHash('sha256').update(b).digest('hex');
const copy = x => JSON.parse(JSON.stringify(x));
function makeCase({split = 'holdout', tag = 'speech_only', disposition = 'identifiable'} = {}) {
  const caseId = randomUUID(), name = `Cafe ${caseId.slice(0, 8)}`, caption = tag === 'caption_control' ? `${name} Paris` : `Post ${caseId}: A place in Paris`;
  const text = Buffer.from(caption), video = Buffer.from(`SYNTHETIC structural fixture, not a video: ${caseId}`);
  const asset = (assetId, kind, bytes) => ({assetId, kind, sha256: hash(bytes), byteLength: bytes.length, durationMs: kind === 'video' ? 30000 : null, clipStartMs: 0, language: 'en', provenance: 'captured_original', textLength: kind === 'caption' ? caption.length : null});
  const assets = [asset('caption', 'caption', text), asset('video', 'video', video)];
  const captionRef = {assetId: 'caption', modality: 'text', intervalMs: null, textRange: [0, caption.length], region: null};
  const audioRef = {assetId: 'video', modality: 'audio', intervalMs: [1000, 2000], textRange: null, region: null};
  const frameRef = {assetId: 'video', modality: 'frame', intervalMs: [1000, 1000], textRange: null, region: [0, 0, 1, 1]};
  const venue = {venueId: `venue-${caseId}`, branchId: 'paris'};
  const expectedVenues = disposition === 'identifiable' ? [venue] : [];
  const nameRefs = tag === 'caption_control' ? [captionRef] : tag === 'brief_sign' ? [frameRef] : tag === 'complementary' ? [audioRef, frameRef] : [audioRef];
  const coverage = disposition === 'no_venue' ? ['no_venue'] : disposition === 'ambiguous' ? ['ambiguous_branch'] : disposition === 'insufficient_capture' ? [] : [tag];
  const row = {caseId, split, platform: 'instagram', language: 'en', capturedAt: '2026-09-20T00:00:00.000Z', evidenceSha256: checksum(assets), expectedVenues,
    verification: {annotatorId: randomUUID(), verifierId: randomUUID(), verifiedAt: '2026-09-20T01:00:00.000Z', method: 'independent_identity_check'}, reportedFailure: split === 'development', coverage, familyId: `family-${caseId}`, disposition, assets,
    supports: expectedVenues.length ? [{...venue, nameRefs, branchRefs: [captionRef]}] : []};
  const query = `${name} Paris`;
  const observation = refs => ({query, name, city: 'Paris', country: null, address: null, nameRefs: refs, branchRefs: [captionRef], requiresSelection: false});
  const observed = refs => ({status: 'complete', plannedRefs: copy(refs), observedRefs: copy(refs), reason: null});
  const responses = {
    baseline: {text: caption, observations: tag === 'caption_control' && expectedVenues.length ? [observation([captionRef])] : [], needsMoreEvidence: tag !== 'caption_control', coverage: null},
    audio: {text: expectedVenues.length ? `${name} in Paris` : 'Background music', observations: ['speech_only', 'complementary'].includes(tag) && expectedVenues.length ? [observation([audioRef])] : [], needsMoreEvidence: false, coverage: observed([audioRef])},
    frames: {text: expectedVenues.length ? `${name} Paris` : 'A street', observations: ['brief_sign', 'complementary'].includes(tag) && expectedVenues.length ? [observation([frameRef])] : [], needsMoreEvidence: false, coverage: observed([frameRef])},
  };
  return {row, name, venue, captionRef, audioRef, frameRef, responses,
    files: new Map([[hash(text), text], [hash(video), video]]),
    frozen: {caseId, query, results: [{place_id: `place-${caseId}`, name, formatted_address: 'Paris France', lat: 48.85, lng: 2.35, ...venue}]}};
}
function fixture() {
  const parts = [makeCase({split: 'development'}), makeCase({split: 'development', tag: 'caption_control'}), makeCase({tag: 'caption_control'}), makeCase(), makeCase({tag: 'brief_sign'}), makeCase({tag: 'complementary'}), makeCase({disposition: 'ambiguous'}), makeCase({disposition: 'no_venue'}), makeCase({disposition: 'insufficient_capture'})];
  const corpus = {schemaVersion: 2, corpusId: randomUUID(), kind: 'independently_labeled_real_posts', holdoutUsedForTuning: false, cases: parts.map(p => p.row)};
  const seal = sealCorpus(corpus), inputs = createReplayInputs(corpus, seal, 'holdout'), selected = parts.filter(p => p.row.split === 'holdout');
  const recordings = {schemaVersion: 2, inputsSha256: checksum(inputs), versions: {engine: 'synthetic-test', prompt: 'test', model: 'recorded', sampling: 'test', adapter: 'test'}, cacheState: 'cold', cases: selected.map(p => ({caseId: p.row.caseId, responses: copy(p.responses), metricsByArm: Object.fromEntries(ARMS.map(a => [a, []]))}))};
  const places = {schemaVersion: 2, inputsSha256: checksum(inputs), entries: selected.map(p => p.frozen)};
  const predictions = {schemaVersion: 2, corpusSha256: seal.corpusSha256, mode: 'captured_evidence', split: 'holdout', authorizedLiveRetrieval: false, arm: 'baseline', execution: 'recorded_replay', versions: copy(recordings.versions), cacheState: 'cold', frozenPlacesSha256: checksum(places), results: selected.map(p => ({caseId: p.row.caseId, evidenceSha256: p.row.evidenceSha256, sourceStatus: 'captured', candidates: [], automaticDecisions: [], autoSaved: [], confirmedSaved: [], saveAttestation: null, requiresConfirmation: false, partial: false, analysis: {audio: emptyCoverage(), frames: emptyCoverage()}, attemptMetrics: [], failure: null}))};
  return {corpus, seal, inputs, recordings, places, predictions, parts, selected, files: new Map(parts.flatMap(p => [...p.files])), copy};
}
function addCandidate(result, part, modality = 'audio') {
  const ref = modality === 'frames' ? part.frameRef : modality === 'baseline' ? part.captionRef : part.audioRef;
  if (modality !== 'baseline') result.analysis[modality] = {status: 'complete', plannedRefs: [copy(ref)], observedRefs: [copy(ref)], reason: null};
  result.candidates.push({...part.venue, nameRefs: [copy(ref)], branchRefs: [copy(part.captionRef)], requiresSelection: modality !== 'baseline'});
  result.requiresConfirmation = modality !== 'baseline';
}
module.exports = {fixture, makeCase, addCandidate, copy};
