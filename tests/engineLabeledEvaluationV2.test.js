'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {randomUUID} = require('crypto');
const schema = require('../lib/labeledEvaluationSchema');
const {evaluateLabeledCorpus} = require('../lib/labeledEvaluation');
const {createMetrics} = require('../lib/engineMetrics');
const {fixture, makeCase, addCandidate, copy} = require('./helpers/multimodalEvaluationFixture');
const reseal = f => {f.seal = schema.sealCorpus(f.corpus); f.predictions.corpusSha256 = f.seal.corpusSha256;};
const score = (f, options) => evaluateLabeledCorpus(f.corpus, f.predictions, f.seal, options);
function instrument(f, cost = .02, duration = 100) {
  for (const r of f.predictions.results) {
    const label = f.corpus.cases.find(c => c.caseId === r.caseId); let now = 0;
    const metric = createMetrics({platform: label.platform, language: label.language, queueMs: 10, now: () => now,
      prices: {schemaVersion: 1, asOf: '2026-09-20', currency: 'USD', rates: {fixture: {provider: 'google', billing: 'calls', usdPerCall: cost}}}});
    metric.providerCall({provider: 'google', rateKey: 'fixture', outcome: 'success'}); now = duration; r.attemptMetrics = [metric.finish('success')];
  }
}
describe('v2 private corpus and actual asset contracts', () => {
  test('v2 seals roundtrip and the manifest hash covers all asset descriptions', () => {
    const f = fixture(); expect(schema.validateCorpus(f.corpus)).toBe(f.corpus);
    expect(schema.verifySeal(f.corpus, f.seal)).toBe(true); expect(f.seal.schemaVersion).toBe(2);
    f.corpus.cases[0].assets[1].durationMs = 30001;
    expect(() => schema.validateCorpus(f.corpus)).toThrow('manifest checksum');
  });
  test.each(['family', 'venue', 'asset'])('rejects cross-split %s leakage', kind => {
    const f = fixture(), dev = f.corpus.cases[0], hold = f.corpus.cases[3];
    if (kind === 'family') hold.familyId = dev.familyId;
    if (kind === 'venue') {hold.expectedVenues = copy(dev.expectedVenues); Object.assign(hold.supports[0], dev.expectedVenues[0]);}
    if (kind === 'asset') {hold.assets[1] = copy(dev.assets[1]); hold.evidenceSha256 = schema.checksum(hold.assets);}
    expect(() => schema.validateCorpus(f.corpus)).toThrow('Cross-split');
  });
  test.each(['unknown_asset', 'negative_offset', 'past_end', 'bad_region', 'empty_support', 'extra_field', 'wrong_disposition', 'unknown_negative', 'mixed_negative', 'reported_holdout'])('rejects %s', kind => {
    const f = fixture(), r = f.corpus.cases[3], ref = r.supports[0].nameRefs[0];
    if (kind === 'unknown_asset') ref.assetId = 'unknown';
    if (kind === 'negative_offset') ref.intervalMs = [-1, 20];
    if (kind === 'past_end') ref.intervalMs = [0, 30001];
    if (kind === 'bad_region') ref.region = [0, 1, .5, .1];
    if (kind === 'empty_support') r.supports = [];
    if (kind === 'extra_field') r.goldTranscript = 'answer';
    if (kind === 'wrong_disposition') r.disposition = 'ambiguous';
    if (kind === 'unknown_negative') f.corpus.cases.at(-1).coverage = ['no_venue'];
    if (kind === 'mixed_negative') f.corpus.cases.at(-2).expectedVenues = [{venueId: 'one', branchId: 'one'}];
    if (kind === 'reported_holdout') r.reportedFailure = true;
    expect(() => schema.validateCorpus(f.corpus)).toThrow();
  });
  test('every actual asset is hashed, not just its manifest; text lengths and symlinks fail closed', () => {
    const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v2-assets-'));
    try {
      for (const [hash, bytes] of f.files) fs.writeFileSync(path.join(dir, `${hash}.bin`), bytes);
      expect(schema.verifyEvidenceDirectory(f.corpus, dir).checkedFiles).toBe(f.files.size);
      const a = f.corpus.cases[0].assets[1], target = path.join(dir, `${a.sha256}.bin`), original = fs.readFileSync(target);
      fs.writeFileSync(target, Buffer.alloc(original.length));
      expect(() => schema.verifyEvidenceDirectory(f.corpus, dir)).toThrow('checksum');
      fs.writeFileSync(target, original); fs.unlinkSync(target); fs.symlinkSync(path.join(dir, `${f.corpus.cases[0].assets[0].sha256}.bin`), target);
      expect(() => schema.verifyEvidenceDirectory(f.corpus, dir)).toThrow();
      fs.unlinkSync(target); fs.writeFileSync(target, original);
      f.corpus.cases[0].assets[0].textLength += 1; f.corpus.cases[0].evidenceSha256 = schema.checksum(f.corpus.cases[0].assets);
      expect(() => schema.verifyEvidenceDirectory(f.corpus, dir)).toThrow('Text offsets');
    } finally {fs.rmSync(dir, {recursive: true, force: true});}
  });
});
describe('separate candidates, decisions, true saves and unknown dispositions', () => {
  test('candidate improvement does not simulate saves; unknown captures stay out of negatives and recall', () => {
    const f = fixture(); addCandidate(f.predictions.results[1], f.selected[1]);
    const r = score(f);
    expect(r.overall.quality.candidateRecall).toMatchObject({numerator: 1, denominator: 4});
    expect(r.overall.quality.expectedVenueRecall).toMatchObject({numerator: 0, denominator: 4});
    expect(r.overall.quality.noVenueCandidateFalsePositiveRate.denominator).toBe(1);
    expect(r.overall.denominators).toMatchObject({allCases: 7, identifiableCases: 4, verifiedNoVenueCases: 1, ambiguousCases: 1, insufficientCaptureCases: 1, excludedFromVenueRecall: 3});
    expect(r.overall.cost.totalUsd).toBeNull(); expect(r.overall.cost.attemptedLinksDenominator).toBe(7);
    expect(r.byModality.speech_only.quality.candidateRecall.value).toBe(1);
    expect(r.releaseGate.reasons).toContain('complete_observed_cost_required');
  });
  test('ambiguous cases measure abstention, not an invented answer or a negative', () => {
    const f = fixture(); addCandidate(f.predictions.results[4], f.selected[4]);
    expect(score(f).overall.quality.ambiguousAbstentionRate).toMatchObject({numerator: 1, denominator: 1});
    f.predictions.results[4].candidates[0].requiresSelection = false;
    f.predictions.results[4].automaticDecisions = [f.selected[4].venue];
    const r = score(f);
    expect(r.overall.quality.ambiguousAbstentionRate.numerator).toBe(0);
    expect(r.overall.quality.noVenueCandidateFalsePositiveRate.denominator).toBe(1);
    expect(r.releaseGate.reasons).toContain('unresolved_evidence_cannot_support_automatic_or_actual_save');
  });
  test('missing name or branch support counts as unsupported and closes the gate', () => {
    const f = fixture(); addCandidate(f.predictions.results[1], f.selected[1]);
    f.predictions.results[1].candidates[0].branchRefs = [];
    const r = score(f);
    expect(r.overall.quality.candidateRecall.numerator).toBe(1);
    expect(r.overall.quality.groundedCandidateRecall.numerator).toBe(0);
    expect(r.releaseGate.reasons).toContain('unsupported_candidate_or_save');
  });
  test('a valid reference outside the labeled clue is not semantic support', () => {
    const f = fixture(); addCandidate(f.predictions.results[2], f.selected[2], 'frames');
    const r = f.predictions.results[2];
    r.candidates[0].nameRefs[0].intervalMs = [5000, 5000];
    r.analysis.frames.plannedRefs[0].intervalMs = [5000, 5000]; r.analysis.frames.observedRefs[0].intervalMs = [5000, 5000];
    const report = score(f); expect(report.overall.quality.frameClueCapture.numerator).toBe(0);
    expect(report.overall.quality.unsupportedCandidateRate.numerator).toBe(1);
  });
  test('a frame must overlap the private brief-sign interval and cannot borrow audio coverage', () => {
    const f = fixture(), part = f.selected[2], r = f.predictions.results[2];
    const frame = copy(part.frameRef); frame.intervalMs = [12500, 12500];
    part.row.supports[0].nameRefs[0].intervalMs = [12200, 12700]; reseal(f);
    r.analysis.frames = {status: 'complete', plannedRefs: [frame], observedRefs: [copy(frame)], reason: null};
    r.candidates = [{...part.venue, nameRefs: [copy(frame)], branchRefs: [copy(part.captionRef)], requiresSelection: true}];
    expect(score(f).byModality.brief_sign.quality.frameClueCapture).toMatchObject({numerator: 1, denominator: 1});
    expect(score(f).overall.quality.groundedCandidateRecall.numerator).toBe(1);
    r.analysis.frames = {status: 'unattempted', plannedRefs: [], observedRefs: [], reason: null};
    const audio = {...frame, modality: 'audio', intervalMs: [12000, 13000], region: null};
    r.analysis.audio = {status: 'complete', plannedRefs: [audio], observedRefs: [copy(audio)], reason: null};
    expect(() => score(f)).toThrow('unobserved');
  });
  test.each(['fake_confirmation', 'fake_auto', 'decision_requires_selection', 'unobserved', 'false_complete', 'coverage_gap', 'missing_case', 'misattributed_metric'])('rejects %s predictions', kind => {
    const f = fixture(); addCandidate(f.predictions.results[1], f.selected[1]); const r = f.predictions.results[1];
    if (kind === 'fake_confirmation') r.confirmedSaved = [{...f.selected[1].venue, isNew: true}];
    if (kind === 'fake_auto') {r.candidates[0].requiresSelection = false; r.automaticDecisions = [f.selected[1].venue]; r.autoSaved = [{...f.selected[1].venue, isNew: true}];}
    if (kind === 'decision_requires_selection') r.automaticDecisions = [f.selected[1].venue];
    if (kind === 'unobserved') {r.analysis.audio = {status: 'unattempted', plannedRefs: [], observedRefs: [], reason: null};}
    if (kind === 'false_complete') r.analysis.audio.observedRefs = [];
    if (kind === 'coverage_gap') {r.analysis.audio.plannedRefs.push({...f.selected[1].audioRef, intervalMs: [4000, 5000]}); r.analysis.audio.status = 'partial'; r.analysis.audio.reason = 'unread_chunk';}
    if (kind === 'missing_case') f.predictions.results.pop();
    if (kind === 'misattributed_metric') {instrument(f); r.attemptMetrics[0].language = 'ja';}
    expect(() => score(f)).toThrow();
  });
  test('isolated tester saves require attestation and are scored separately from proposals', () => {
    const f = fixture(); addCandidate(f.predictions.results[1], f.selected[1]); f.predictions.execution = 'isolated_tester';
    const r = f.predictions.results[1]; r.confirmedSaved = [{...f.selected[1].venue, isNew: true}];
    expect(() => score(f)).toThrow('attestation');
    r.saveAttestation = {environment: 'isolated_test', testerId: randomUUID(), recordedAt: '2026-09-21T00:00:00.000Z'};
    expect(score(f).overall.quality.expectedVenueRecall.numerator).toBe(1);
  });
});
describe('modality comparisons and release gates', () => {
  test('recall regressions block even when aggregate recall is unchanged', () => {
    const f = fixture(); instrument(f); addCandidate(f.predictions.results[1], f.selected[1]); const baseline = score(f);
    f.predictions.results[1].candidates = []; addCandidate(f.predictions.results[2], f.selected[2], 'frames');
    const r = score(f, {baseline});
    expect(r.overall.quality.candidateRecall.value).toBe(baseline.overall.quality.candidateRecall.value);
    expect(r.comparison.recallRegressionCaseIds).toEqual([f.selected[1].row.caseId]);
    expect(r.releaseGate.reasons).toContain('baseline_recall_regression');
    expect(r.comparison.pairedPosts).toMatchObject({wins: 1, losses: 1, ties: 2});
  });
  test('incremental cost is per additional correct candidate; unknown cost never becomes zero', () => {
    const f = fixture(); instrument(f); const baseline = score(f); addCandidate(f.predictions.results[1], f.selected[1]); instrument(f, .03);
    const r = score(f, {baseline}); expect(r.comparison.incrementalCost.additionalCorrectCandidates).toBe(1);
    expect(r.comparison.incrementalCost.perAdditionalCorrectCandidateUsd).toBeCloseTo(.07);
    expect(r.releaseGate.reasons).toContain('latency_or_cost_growth_at_least_10_percent_requires_documented_tradeoff');
    f.predictions.results[1].attemptMetrics = [];
    expect(score(f, {baseline}).comparison.incrementalCost.perAdditionalCorrectCandidateUsd).toBeNull();
  });
  test('retains 100/50 gate and separately requires all modalities in sealed holdout', () => {
    const f = fixture(); const r = score(f);
    expect(r.releaseGate.reasons).toContain('missing_required_real_corpus_100_development_50_holdout');
    expect(r.releaseGate.reasons).toContain('insufficient_holdout_modality_speech_only');
    expect(r.releaseGate.reasons).toContain('insufficient_holdout_modality_brief_sign');
    expect(r.releaseGate.readyForRollout).toBe(false);
  });
  test('a structurally sufficient SYNTHETIC 100/60 replay still cannot clear production latency', () => {
    // Generated contract test only, never written to a corpus/evaluation artifact.
    const f = fixture(), tags = ['caption_control', 'speech_only', 'brief_sign', 'complementary', 'ambiguous_branch', 'no_venue'];
    const dev = Array.from({length: 100}, () => makeCase({split: 'development'}));
    const hold = Array.from({length: 60}, (_, i) => makeCase({tag: tags[i % 6], disposition: i % 6 === 4 ? 'ambiguous' : i % 6 === 5 ? 'no_venue' : 'identifiable'}));
    hold[0].row.coverage.push('tags', 'branches', 'missing_caption', 'multiple_places');
    const second = {...hold[0].venue, venueId: 'second-venue'};
    hold[0].row.expectedVenues.push(second); hold[0].row.supports.push({...copy(hold[0].row.supports[0]), ...second});
    hold[1].row.language = 'ja';
    f.corpus.cases = [...dev, ...hold].map(p => p.row); f.seal = schema.sealCorpus(f.corpus);
    const template = copy(f.predictions.results[0]);
    f.predictions.corpusSha256 = f.seal.corpusSha256;
    f.predictions.results = hold.map(p => ({...copy(template), caseId: p.row.caseId, evidenceSha256: p.row.evidenceSha256}));
    for (let i = 0; i < hold.length; i++) if (i % 6 === 0) {
      addCandidate(f.predictions.results[i], hold[i], 'baseline');
      if (i === 0) f.predictions.results[i].candidates.push({...copy(f.predictions.results[i].candidates[0]), ...second});
    }
    instrument(f); const baseline = score(f);
    for (let i = 0; i < hold.length; i++) if ([1, 2, 3].includes(i % 6)) addCandidate(f.predictions.results[i], hold[i], i % 6 === 2 ? 'frames' : 'audio');
    const report = score(f, {baseline});
    expect(report.releaseGate).toMatchObject({measurementReady: false, readyForRollout: false, reasons: ['production_latency_validation_required']});
    expect(report.latencyEvidence).toMatchObject({scope: 'unspecified', deploymentGate: 'blocked'});
    // Holding the total case count constant does not excuse absent holdout slices.
    f.corpus.cases.filter(c => c.coverage.includes('brief_sign')).forEach(c => {c.coverage = c.coverage.filter(t => t !== 'brief_sign');});
    reseal(f);
    expect(score(f).releaseGate.reasons).toContain('insufficient_holdout_modality_brief_sign');
  });
  test('audio observations cannot count a visual-only clue as captured', () => {
    const f = fixture(), part = f.selected[3], result = f.predictions.results[3];
    const observed = copy(part.audioRef);
    // The spoken clue is later than the selected frame; audio covers only frame time.
    part.row.supports[0].nameRefs[0].intervalMs = [10000, 11000]; reseal(f);
    result.analysis.audio = {status: 'complete', plannedRefs: [observed], observedRefs: [copy(observed)], reason: null};
    const r = score(f);
    expect(r.byModality.complementary.quality.audioClueCapture).toMatchObject({numerator: 0, denominator: 1});
  });
  test('new wrong branches in automatic decisions AND real confirmations block', () => {
    for (const actual of [false, true]) {
      const f = fixture(); if (actual) f.predictions.execution = 'isolated_tester';
      const baseline = score(f); addCandidate(f.predictions.results[1], f.selected[1]); const r = f.predictions.results[1];
      r.candidates[0].branchId = 'wrong'; r.candidates[0].requiresSelection = false;
      if (actual) {r.confirmedSaved = [{...f.selected[1].venue, branchId: 'wrong', isNew: true}]; r.saveAttestation = {environment: 'isolated_test', testerId: randomUUID(), recordedAt: '2026-09-21T00:00:00.000Z'};}
      else r.automaticDecisions = [{...f.selected[1].venue, branchId: 'wrong'}];
      expect(score(f, {baseline}).comparison.confirmedNewWrongPlaceRegressions).toBe(1);
    }
  });
  test.each(['cache', 'places', 'execution', 'checksum'])('rejects mismatched %s baselines', kind => {
    const f = fixture(), baseline = score(f);
    if (kind === 'cache') baseline.cacheState = 'warm';
    if (kind === 'places') baseline.frozenPlacesSha256 = '0'.repeat(64);
    if (kind === 'execution') baseline.execution = 'captured_inference';
    if (kind === 'checksum') baseline.caseResults[0].correctCandidates++;
    expect(() => score(f, {baseline})).toThrow('Baseline');
  });
});
