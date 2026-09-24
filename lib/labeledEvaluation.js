'use strict';

const {validatePredictions, checksum, identity, COVERAGE} = require('./labeledEvaluationSchema');
const {ratio, distribution, summarizeMetrics, compareAggregates} = require('./engineMetrics');

function scoreCase(label, result) {
  const expected = new Set(label.expectedVenues.map(identity));
  const venueIds = new Set(label.expectedVenues.map(v => v.venueId));
  const automatic = result.autoSaved, saved = [...automatic, ...result.confirmedSaved];
  const correct = v => expected.has(identity(v));
  return {caseId: label.caseId, platform: label.platform, language: label.language,
    expectedVenues: expected.size, autoSaves: automatic.length, correctAutoSaves: automatic.filter(correct).length,
    wrongBranchAutoSaves: automatic.filter(v => !correct(v) && venueIds.has(v.venueId)).length,
    wrongPlaceAutoSaves: automatic.filter(v => !venueIds.has(v.venueId)).length,
    confirmedSaves: result.confirmedSaved.length, correctConfirmedSaves: result.confirmedSaved.filter(correct).length,
    recalledVenues: saved.filter(correct).length, correctlySavedNewPlaces: saved.filter(v => v.isNew && correct(v)).length,
    noVenue: expected.size === 0, falsePositiveNoVenue: expected.size === 0 && automatic.length > 0,
    requiresConfirmation: result.requiresConfirmation, partial: result.partial, sourceStatus: result.sourceStatus,
    wrongAutoSaveChecksums: automatic.filter(v => !correct(v)).map(v => checksum({venueId: v.venueId, branchId: v.branchId})).sort(),
    wrongSaveChecksums: saved.filter(v => !correct(v)).map(v => checksum({venueId: v.venueId, branchId: v.branchId})).sort(),
    attemptMetrics: result.attemptMetrics};
}
function summarizeCases(rows, mode) {
  const sum = key => rows.reduce((s, row) => s + row[key], 0);
  const n = rows.length, live = mode === 'authorized_live_retrieval';
  const metrics = summarizeMetrics(rows.flatMap(r => r.attemptMetrics));
  // Sum all attempts (including retries) for each attempted link. Missing queue
  // samples make that link's queue duration unknown, rather than silently zero.
  const times = key => rows.map(r => r.attemptMetrics.length && r.attemptMetrics.every(m => m[key] !== null)
    ? r.attemptMetrics.reduce((s, m) => s + m[key], 0) : null);
  const complete = n > 0 && rows.every(r => r.attemptMetrics.length > 0) && metrics.overall.cost.unknownAttempts === 0;
  const totalUsd = complete ? metrics.overall.cost.totalUsd : null;
  const correctNew = live ? null : sum('correctlySavedNewPlaces');
  const noVenue = rows.filter(r => r.noVenue);
  return {attemptedLinks: n, instrumentedAttempts: metrics.overall.attempts,
    queueMs: distribution(times('queueMs'), n), processingMs: distribution(times('processingMs'), n),
    cost: {currency: 'USD', knownUsd: metrics.overall.cost.knownUsd, totalUsd,
      linksWithMetrics: rows.filter(r => r.attemptMetrics.length).length,
      linksWithCompleteObservedCost: rows.filter(r => r.attemptMetrics.length && summarizeMetrics(r.attemptMetrics).overall.cost.unknownAttempts === 0).length,
      attemptedLinksDenominator: n, perAttemptedLinkUsd: totalUsd === null ? null : totalUsd / n,
      correctlySavedNewPlacesDenominator: correctNew,
      perCorrectlySavedNewPlaceUsd: totalUsd === null || !correctNew ? null : totalUsd / correctNew,
      priceDates: metrics.overall.cost.priceDates, validation: 'observed_usage_estimate_not_invoice_reconciled'},
    quality: live ? null : {
      autoSavePrecision: ratio(sum('correctAutoSaves'), sum('autoSaves')),
      wrongPlaceOrBranchRate: ratio(sum('wrongPlaceAutoSaves') + sum('wrongBranchAutoSaves'), sum('autoSaves')),
      wrongPlaceRate: ratio(sum('wrongPlaceAutoSaves'), sum('autoSaves')),
      wrongBranchRate: ratio(sum('wrongBranchAutoSaves'), sum('autoSaves')),
      confirmedSavePrecision: ratio(sum('correctConfirmedSaves'), sum('confirmedSaves')),
      expectedVenueRecall: ratio(sum('recalledVenues'), sum('expectedVenues')),
      missedVenues: sum('expectedVenues') - sum('recalledVenues'),
      humanConfirmationRate: ratio(rows.filter(r => r.requiresConfirmation).length, n),
      partialOutcomeRate: ratio(rows.filter(r => r.partial).length, n),
      noVenueFalsePositiveLinkRate: ratio(noVenue.filter(r => r.falsePositiveNoVenue).length, noVenue.length),
    },
    accessibility: live ? {
      accessibleRate: ratio(rows.filter(r => r.sourceStatus === 'accessible').length, n),
      blockedSourceRate: ratio(rows.filter(r => ['blocked', 'rate_limited'].includes(r.sourceStatus)).length, n),
      unavailableRate: ratio(rows.filter(r => r.sourceStatus === 'unavailable').length, n),
      rateLimitedRate: ratio(rows.filter(r => r.sourceStatus === 'rate_limited').length, n),
    } : null};
}
function compareEvaluations(report, baseline) {
  if (baseline?.schemaVersion !== 1 || baseline.scope !== report.scope || baseline.mode !== report.mode || baseline.split !== report.split || baseline.corpusSha256 !== report.corpusSha256 || !Array.isArray(baseline.caseResults)) throw new Error('Baseline must use identical corpus checksum, split, and evaluation mode');
  const prior = new Map(baseline.caseResults.map(r => [r.caseId, r]));
  if (prior.size !== baseline.caseResults.length || prior.size !== report.caseResults.length || report.caseResults.some(r => !prior.has(r.caseId))) throw new Error('Baseline case coverage mismatch');
  if (baseline.caseResults.some(r => !Array.isArray(r.wrongSaveChecksums) || r.wrongSaveChecksums.some(hash => !/^[0-9a-f]{64}$/.test(hash)))) throw new Error('Invalid baseline wrong-save evidence');
  const regressions = report.caseResults.filter(row => row.wrongSaveChecksums.some(hash => !prior.get(row.caseId).wrongSaveChecksums.includes(hash))).map(row => row.caseId);
  return {...compareAggregates(report, baseline), confirmedNewWrongPlaceRegressions: regressions.length,
    regressionCaseIds: regressions, blockExpansion: regressions.length > 0};
}
function evaluateLabeledCorpus(corpus, predictions, manifest, {baseline = null} = {}) {
  if (corpus?.schemaVersion === 2) return require('./labeledEvaluationV2').evaluateV2(corpus, predictions, manifest, {baseline});
  validatePredictions(predictions, corpus, manifest);
  // Validate all attempts jointly as well, so a reused report cannot double-count
  // a retry's cost in multiple links or groups.
  summarizeMetrics(predictions.results.flatMap(r => r.attemptMetrics));
  const results = new Map(predictions.results.map(r => [r.caseId, r]));
  const rows = corpus.cases.filter(c => c.split === predictions.split).map(c => scoreCase(c, results.get(c.caseId)));
  const group = key => Object.fromEntries([...new Set(rows.map(r => r[key]))].sort().map(value => [value, summarizeCases(rows.filter(r => r[key] === value), predictions.mode)]));
  const development = corpus.cases.filter(c => c.split === 'development'), holdout = corpus.cases.filter(c => c.split === 'holdout');
  const reasons = [];
  if (development.length < 100 || holdout.length < 50) reasons.push('missing_required_real_corpus_100_development_50_holdout');
  if (development.filter(c => c.reportedFailure).length < 2) reasons.push('two_reported_failures_need_development_regressions');
  if (new Set(corpus.cases.map(c => c.language).filter(l => !['unknown', 'other', 'mixed'].includes(l))).size < 2) reasons.push('multilingual_coverage_required');
  if (COVERAGE.some(tag => !corpus.cases.some(c => c.coverage.includes(tag)))) reasons.push('required_case_coverage_missing');
  if (predictions.split !== 'holdout' || predictions.mode !== 'captured_evidence') reasons.push('sealed_captured_evidence_holdout_evaluation_required');
  if (!baseline) reasons.push('comparable_baseline_required');
  const report = {schemaVersion: 1, scope: 'operator_attested_real_corpus_evaluation', mode: predictions.mode, split: predictions.split,
    corpusSha256: manifest.corpusSha256, holdoutSha256: manifest.holdoutSha256, generatedAt: new Date().toISOString(),
    sample: {developmentCases: development.length, sealedCases: holdout.length, evaluatedCases: rows.length},
    overall: summarizeCases(rows, predictions.mode), byPlatform: group('platform'), byLanguage: group('language'),
    caseResults: rows.map(({attemptMetrics, ...row}) => row),
    limitations: [
      'Real provenance and independent verification are operator attestations; this tool cannot authenticate them.',
      'Wilson 95% intervals assume independent observations; venues within posts are clustered, so precision/recall intervals are descriptive and may be too narrow.',
      'A 50-case holdout is an initial check, not population-wide accuracy. Replace it after tuning exposure; checksums cannot prove it remained unseen.',
      'Captured evidence measures saved venue/branch identity, not live accessibility. Live retrieval reports never score reasoning quality.',
      'Expected-venue recall counts unique correct automatic or human-confirmed saves; unconfirmed suggestions do not count.',
      'Processing/queue delays sum instrumented attempts per link and exclude unrecorded retry gaps. Missing instrumentation is unknown.',
      'Cost covers observed instrumented calls only, using supplied dated prices; provider usage reconciliation remains required.',
      'Synthetic unit/regression tests are never evidence for real accuracy or corpus completeness.',
    ]};
  report.comparison = baseline ? compareEvaluations(report, baseline) : null;
  if (report.comparison?.blockExpansion) reasons.push('confirmed_new_wrong_place_or_branch_regression');
  if (report.comparison?.investigationRequired) reasons.push('latency_or_cost_growth_at_least_10_percent_requires_documented_tradeoff');
  if (report.overall.cost.totalUsd === null) reasons.push('complete_observed_cost_required');
  if (report.overall.queueMs.missing || report.overall.processingMs.missing) reasons.push('complete_latency_samples_required');
  if (report.comparison?.changes.some(c => c.status === 'unavailable')) reasons.push('baseline_comparison_has_unknown_measurements');
  report.releaseGate = {measurementReady: reasons.length === 0, readyForRollout: false, reasons,
    externalChecks: ['audit_independent_real_label_provenance', 'confirm_holdout_chain_of_custody', 'authorized_live_accessibility_sample', 'reconcile_provider_usage', 'document_rollout_tradeoffs_and_review']};
  return report;
}
module.exports = {scoreCase, summarizeCases, compareEvaluations, evaluateLabeledCorpus};
