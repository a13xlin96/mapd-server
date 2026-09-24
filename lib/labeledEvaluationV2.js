'use strict';
const {identity, checksum, validatePredictions} = require('./labeledEvaluationSchema');
const {MODALITIES, DISPOSITIONS} = require('./labeledEvaluationSchemaV2');
const {overlaps} = require('./labeledPredictionV2');
const {summarizeCases} = require('./labeledEvaluation');
const {ratio, summarizeMetrics, compareAggregates} = require('./engineMetrics');
// Frozen before holdout inspection. These are evaluation gates, never dispatch
// or monetary controls. Per-slice minima remain a small challenge-set gate.
const GATES = Object.freeze({development: 100, holdout: 50, perModalityHoldout: 5, version: 'media-eval-gates-v1'});
function scoreV2(label, result) {
  const identifiable = label.disposition === 'identifiable', negative = label.disposition === 'no_venue';
  const comparable = identifiable || negative;
  const expected = new Set(label.expectedVenues.map(identity)), expectedIds = new Set(label.expectedVenues.map(v => v.venueId));
  const correct = v => expected.has(identity(v)), saved = [...result.autoSaved, ...result.confirmedSaved];
  const support = c => {
    if (!comparable) return null;
    const s = label.supports.find(v => identity(v) === identity(c));
    return s ? {name: c.nameRefs.some(r => s.nameRefs.some(g => overlaps(r, g))), branch: c.branchRefs.some(r => s.branchRefs.some(g => overlaps(r, g)))} : {name: false, branch: false};
  };
  const grounded = c => {const s = support(c); return s && s.name && s.branch;};
  const unsupported = result.candidates.filter(c => comparable && !grounded(c));
  const unsupportedKeys = new Set(unsupported.map(identity));
  const actualWrong = saved.filter(v => comparable && !correct(v));
  const unsafeUnknown = saved.filter(() => !comparable);
  const wrongDecisions = result.automaticDecisions.filter(v => !identifiable || !correct(v));
  const keyHash = v => checksum({venueId: v.venueId, branchId: v.branchId});
  const clue = kind => {
    const eligible = r => r.modality === (kind === 'audio' ? 'audio' : 'frame');
    const relevant = label.supports.filter(s => s.nameRefs.some(eligible));
    return {expected: relevant.length, captured: relevant.filter(s => s.nameRefs.filter(eligible).some(r => result.analysis[kind].observedRefs.some(o => overlaps(o, r)))).length};
  };
  const audio = clue('audio'), frames = clue('frames');
  return {caseId: label.caseId, platform: label.platform, language: label.language, disposition: label.disposition, coverage: label.coverage,
    expectedVenues: identifiable ? expected.size : 0,
    autoSaves: comparable ? result.autoSaved.length : 0, correctAutoSaves: result.autoSaved.filter(correct).length,
    wrongBranchAutoSaves: result.autoSaved.filter(v => comparable && !correct(v) && expectedIds.has(v.venueId)).length,
    wrongPlaceAutoSaves: result.autoSaved.filter(v => comparable && !expectedIds.has(v.venueId)).length,
    confirmedSaves: comparable ? result.confirmedSaved.length : 0, correctConfirmedSaves: result.confirmedSaved.filter(correct).length,
    recalledVenues: saved.filter(correct).length, correctlySavedNewPlaces: saved.filter(v => v.isNew && correct(v)).length,
    noVenue: negative, falsePositiveNoVenue: negative && saved.length > 0,
    requiresConfirmation: result.requiresConfirmation, partial: result.partial, sourceStatus: result.sourceStatus,
    proposedCandidates: comparable ? result.candidates.length : 0, correctCandidates: result.candidates.filter(correct).length,
    groundedCandidates: result.candidates.filter(grounded).length, unsupportedCandidates: unsupported.length,
    excludedCandidates: comparable ? 0 : result.candidates.length, excludedSaves: comparable ? 0 : saved.length,
    automaticDecisions: result.automaticDecisions.length, correctAutomaticDecisions: result.automaticDecisions.filter(correct).length,
    unsafeUnknownSaves: unsafeUnknown.length, automaticRecall: result.automaticDecisions.filter(correct).length,
    unsafeAmbiguousDecisions: !comparable ? result.automaticDecisions.length : 0,
    actualSaves: saved.length, comparableActualSaves: comparable ? saved.length : 0,
    unsupportedSaves: saved.filter(v => unsupportedKeys.has(identity(v))).length,
    fullCandidateRecovery: identifiable && label.expectedVenues.every(v => result.candidates.some(c => identity(v) === identity(c))),
    fullSavedRecovery: identifiable && label.expectedVenues.every(v => saved.some(c => identity(v) === identity(c))),
    negativeCandidate: negative && result.candidates.length > 0,
    ambiguousAbstention: label.disposition === 'ambiguous' && !result.automaticDecisions.length && !saved.length,
    audioClues: audio.expected, capturedAudioClues: audio.captured, frameClues: frames.expected, capturedFrameClues: frames.captured,
    evidenceComplete: Object.values(result.analysis).every(c => ['unattempted', 'complete'].includes(c.status)),
    failure: result.failure,
    wrongSaveChecksums: actualWrong.map(keyHash).sort(), wrongAutoSaveChecksums: result.autoSaved.filter(v => comparable && !correct(v)).map(keyHash).sort(),
    wrongDecisionChecksums: wrongDecisions.map(keyHash).sort(), unsupportedCandidateChecksums: unsupported.map(keyHash).sort(),
    actualSaveChecksums: unsafeUnknown.map(keyHash).sort(),
    attemptMetrics: result.attemptMetrics};
}
function summarizeV2(rows, mode) {
  const base = summarizeCases(rows, mode), sum = key => rows.reduce((s, r) => s + r[key], 0);
  const identifiable = rows.filter(r => r.disposition === 'identifiable'), negatives = rows.filter(r => r.noVenue), ambiguous = rows.filter(r => r.disposition === 'ambiguous');
  base.denominators = {allCases: rows.length, identifiableCases: identifiable.length, verifiedNoVenueCases: negatives.length,
    ambiguousCases: ambiguous.length, insufficientCaptureCases: rows.filter(r => r.disposition === 'insufficient_capture').length,
    excludedFromVenueRecall: rows.filter(r => r.disposition !== 'identifiable').length,
    excludedFromProvenNegativeRate: rows.filter(r => !r.noVenue).length, excludedCandidateIdentities: sum('excludedCandidates'), excludedActualSaves: sum('excludedSaves')};
  if (base.quality) Object.assign(base.quality, {
    candidatePrecision: ratio(sum('correctCandidates'), sum('proposedCandidates')),
    candidateRecall: ratio(sum('correctCandidates'), sum('expectedVenues')),
    groundedCandidateRecall: ratio(sum('groundedCandidates'), sum('expectedVenues')),
    unsupportedCandidateRate: ratio(sum('unsupportedCandidates'), sum('proposedCandidates')),
    unsupportedSaveRate: ratio(sum('unsupportedSaves'), sum('comparableActualSaves')),
    automaticDecisionPrecision: ratio(sum('correctAutomaticDecisions'), sum('automaticDecisions')),
    automaticDecisionRecall: ratio(sum('automaticRecall'), sum('expectedVenues')),
    fullyRecoveredPostRate: ratio(identifiable.filter(r => r.fullCandidateRecovery).length, identifiable.length),
    fullySavedPostRate: ratio(identifiable.filter(r => r.fullSavedRecovery).length, identifiable.length),
    noVenueCandidateFalsePositiveRate: ratio(negatives.filter(r => r.negativeCandidate).length, negatives.length),
    ambiguousAbstentionRate: ratio(ambiguous.filter(r => r.ambiguousAbstention).length, ambiguous.length),
    unsafeUnknownSaves: sum('unsafeUnknownSaves'), unsafeAmbiguousDecisions: sum('unsafeAmbiguousDecisions'),
    audioClueCapture: ratio(sum('capturedAudioClues'), sum('audioClues')),
    frameClueCapture: ratio(sum('capturedFrameClues'), sum('frameClues')),
    incompleteEvidenceRate: ratio(rows.filter(r => !r.evidenceComplete).length, rows.length),
    failedAttemptRate: ratio(rows.filter(r => r.failure !== null).length, rows.length),
  });
  base.cost.correctCandidateDenominator = mode === 'captured_evidence' ? sum('correctCandidates') : null;
  base.cost.perCorrectCandidateUsd = base.cost.totalUsd !== null && base.cost.correctCandidateDenominator ? base.cost.totalUsd / base.cost.correctCandidateDenominator : null;
  return base;
}
function compareV2(report, baseline) {
  if (baseline?.schemaVersion !== 2 || baseline.scope !== report.scope || baseline.mode !== report.mode || baseline.split !== report.split || baseline.corpusSha256 !== report.corpusSha256 || baseline.frozenPlacesSha256 !== report.frozenPlacesSha256 || baseline.cacheState !== report.cacheState || baseline.execution !== report.execution || baseline.gateVersion !== report.gateVersion || !Array.isArray(baseline.caseResults) || baseline.caseResultsSha256 !== checksum(baseline.caseResults)) throw new Error('Baseline must use identical corpus, frozen Places, execution, cache state and gate policy');
  const prior = new Map(baseline.caseResults.map(r => [r.caseId, r]));
  if (prior.size !== report.caseResults.length || prior.size !== baseline.caseResults.length || report.caseResults.some(r => !prior.has(r.caseId))) throw new Error('Baseline case coverage mismatch');
  const newErrors = (row, field) => row[field].some(v => !prior.get(row.caseId)[field].includes(v));
  const wrong = report.caseResults.filter(r => newErrors(r, 'wrongSaveChecksums') || newErrors(r, 'wrongDecisionChecksums') || newErrors(r, 'actualSaveChecksums'));
  const recall = report.caseResults.filter(r => r.correctCandidates < prior.get(r.caseId).correctCandidates || r.recalledVenues < prior.get(r.caseId).recalledVenues || r.groundedCandidates < prior.get(r.caseId).groundedCandidates);
  const changes = report.caseResults.filter(r => r.disposition === 'identifiable').map(r => ({caseId: r.caseId, delta: (r.correctCandidates - prior.get(r.caseId).correctCandidates) / r.expectedVenues}));
  const wins = changes.filter(r => r.delta > 0).length, losses = changes.filter(r => r.delta < 0).length;
  const added = report.overall.quality ? report.overall.quality.candidateRecall.numerator - baseline.overall.quality.candidateRecall.numerator : null;
  const cost = report.overall.cost.totalUsd !== null && baseline.overall.cost.totalUsd !== null ? report.overall.cost.totalUsd - baseline.overall.cost.totalUsd : null;
  const aggregate = compareAggregates(report, baseline);
  // Candidate-only replay has no genuine saves: a null cost-per-save is correct,
  // and must not make an otherwise measured candidate comparison impossible.
  aggregate.changes = aggregate.changes.filter(c => c.metric !== 'costPerCorrectlySavedNewPlaceUsd' || report.execution === 'isolated_tester');
  aggregate.investigationRequired = aggregate.changes.some(c => c.investigationRequired);
  return {...aggregate, confirmedNewWrongPlaceRegressions: wrong.length, regressionCaseIds: wrong.map(r => r.caseId),
    recallRegressionCaseIds: recall.map(r => r.caseId), blockExpansion: wrong.length > 0 || recall.length > 0,
    pairedPosts: {identifiablePosts: changes.length, wins, losses, ties: changes.length - wins - losses,
      meanRecallDelta: changes.length ? changes.reduce((s, c) => s + c.delta, 0) / changes.length : null,
      winFractionAmongChangedPosts: ratio(wins, wins + losses)},
    incrementalCost: {additionalCorrectCandidates: added, observedUsdDelta: cost,
      perAdditionalCorrectCandidateUsd: cost !== null && added > 0 ? cost / added : null,
      limitation: 'Candidate recovery is not actual saved-place recall; recorded replay costs come from supplied original observations.'}};
}
/** Provider-free scoring. Scores only supplied independently attested labels;
 * unknown captures remain in operational denominators, never inferred negatives. */
function evaluateV2(corpus, predictions, manifest, {baseline = null} = {}) {
  validatePredictions(predictions, corpus, manifest);
  summarizeMetrics(predictions.results.flatMap(r => r.attemptMetrics));
  const byId = new Map(predictions.results.map(r => [r.caseId, r]));
  const rows = corpus.cases.filter(c => c.split === predictions.split).map(c => scoreV2(c, byId.get(c.caseId)));
  const group = key => Object.fromEntries([...new Set(rows.map(r => r[key]))].sort().map(k => [k, summarizeV2(rows.filter(r => r[key] === k), predictions.mode)]));
  const dev = corpus.cases.filter(c => c.split === 'development'), hold = corpus.cases.filter(c => c.split === 'holdout');
  const reasons = ['production_latency_validation_required'];
  if (dev.length < GATES.development || hold.length < GATES.holdout) reasons.push('missing_required_real_corpus_100_development_50_holdout');
  if (dev.filter(c => c.reportedFailure).length < 2) reasons.push('two_reported_failures_need_development_regressions');
  if (new Set(hold.map(c => c.language).filter(l => !['unknown', 'other', 'mixed'].includes(l))).size < 2) reasons.push('multilingual_holdout_coverage_required');
  for (const tag of MODALITIES) if (hold.filter(c => c.coverage.includes(tag)).length < GATES.perModalityHoldout) reasons.push(`insufficient_holdout_modality_${tag}`);
  if (['tags', 'branches', 'missing_caption', 'multiple_places', 'no_venue'].some(tag => !corpus.cases.some(c => c.coverage.includes(tag)))) reasons.push('required_case_coverage_missing');
  if (!hold.some(c => c.coverage.includes('multiple_places'))) reasons.push('multiple_place_holdout_required');
  if (predictions.split !== 'holdout' || predictions.mode !== 'captured_evidence') reasons.push('sealed_captured_evidence_holdout_evaluation_required');
  if (!baseline) reasons.push('comparable_baseline_required');
  const report = {schemaVersion: 2, scope: 'operator_attested_real_corpus_evaluation', mode: predictions.mode, split: predictions.split,
    arm: predictions.arm, execution: predictions.execution, versions: predictions.versions, cacheState: predictions.cacheState,
    latencyEvidence: {scope: predictions.timing || 'unspecified', deploymentGate: 'blocked', reason: 'local_replay_does_not_measure_production_queue_network_and_commit_latency'},
    frozenPlacesSha256: predictions.frozenPlacesSha256, gateVersion: GATES.version,
    corpusSha256: manifest.corpusSha256, holdoutSha256: manifest.holdoutSha256, generatedAt: new Date().toISOString(),
    sample: {developmentCases: dev.length, sealedCases: hold.length, evaluatedCases: rows.length},
    overall: summarizeV2(rows, predictions.mode), byPlatform: group('platform'), byLanguage: group('language'),
    byDisposition: Object.fromEntries(DISPOSITIONS.map(k => [k, summarizeV2(rows.filter(r => r.disposition === k), predictions.mode)])),
    byModality: Object.fromEntries([...MODALITIES, 'multiple_places'].map(k => [k, summarizeV2(rows.filter(r => r.coverage.includes(k)), predictions.mode)])),
    caseResults: rows.map(({attemptMetrics, ...row}) => row),
    limitations: ['Labels, source families, capture provenance, duration and tester saves are operator attestations, not independently authenticated by this tool.',
      'Synthetic tests do not establish real accuracy. The 100/50 real corpus and holdout custody remain external requirements.',
      'Intervals and independent support annotations check grounding; semantic correctness of the annotations still requires review.',
      'Complete coverage means the declared processing policy completed, not all possible video clues were captured.',
      'Candidate recall and automatic decisions are separate from actual tester saves. Offline replay cannot report actual saves.',
      'Wilson intervals and paired post win counts are descriptive for a targeted challenge set, not population accuracy.',
      'Recorded responses must come from actual captured inputs, not gold transcripts. Replay timing is diagnostic, never production p95; deployment latency validation remains blocked.',
      'Unknown cost remains unknown; observed usage prices are estimates and require invoice reconciliation.',
      'Audio clue capture measures supplied evidence windows, not transcription word accuracy. Audio-name recognition requires inspection of recorded provider output.']};
  report.caseResultsSha256 = checksum(report.caseResults);
  report.comparison = baseline ? compareV2(report, baseline) : null;
  const q = report.overall.quality;
  if (report.comparison?.confirmedNewWrongPlaceRegressions) reasons.push('confirmed_new_wrong_place_or_branch_regression');
  if (report.comparison?.recallRegressionCaseIds.length) reasons.push('baseline_recall_regression');
  if (q?.unsupportedCandidateRate.numerator || q?.unsupportedSaveRate.numerator) reasons.push('unsupported_candidate_or_save');
  if (q?.unsafeUnknownSaves || q?.unsafeAmbiguousDecisions) reasons.push('unresolved_evidence_cannot_support_automatic_or_actual_save');
  if (baseline && q) for (const tag of ['speech_only', 'brief_sign']) {
    const a = report.byModality[tag].quality?.candidateRecall.value, b = baseline.byModality?.[tag]?.quality?.candidateRecall.value;
    if (a == null || b == null || a <= b) reasons.push(`positive_recovery_required_${tag}`);
  }
  if (report.comparison?.investigationRequired) reasons.push('latency_or_cost_growth_at_least_10_percent_requires_documented_tradeoff');
  if (report.comparison && !report.comparison.priceDatesMatch) reasons.push('matched_price_dates_required_for_cost_comparison');
  if (report.overall.cost.totalUsd === null) reasons.push('complete_observed_cost_required');
  if (report.overall.queueMs.missing || report.overall.processingMs.missing) reasons.push('complete_latency_samples_required');
  if (report.comparison?.changes.some(c => c.status === 'unavailable')) reasons.push('baseline_comparison_has_unknown_measurements');
  report.releaseGate = {measurementReady: reasons.length === 0, readyForRollout: false, reasons,
    externalChecks: ['validate_production_latency', 'audit_independent_real_label_provenance', 'confirm_holdout_chain_of_custody', 'authorized_live_accessibility_sample', 'validate_frozen_places_and_recorded_provider_provenance', 'reconcile_provider_usage', 'document_rollout_tradeoffs_and_review']};
  return report;
}
module.exports = {GATES, scoreV2, summarizeV2, compareV2, evaluateV2};
