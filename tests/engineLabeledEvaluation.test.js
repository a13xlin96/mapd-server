'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {randomUUID, createHash} = require('crypto');
const {spawnSync} = require('child_process');
const schema = require('../lib/labeledEvaluationSchema');
const {evaluateLabeledCorpus} = require('../lib/labeledEvaluation');
const {createMetrics} = require('../lib/engineMetrics');
const {writePrivateJson} = require('../scripts/engine-report');
const copy = x => JSON.parse(JSON.stringify(x));

// Synthetic validator/scoring fixtures ONLY. These are not independent real
// annotations and must never be counted toward the 150-case release corpus.
function fixture() {
  const venue = (venueId, branchId = 'branch-a') => ({venueId, branchId});
  const evidenceFiles = new Map();
  const row = (expectedVenues, split = 'holdout', language = 'en') => {
    const bytes = Buffer.from(`Synthetic validator fixture, not real evidence: ${randomUUID()}`);
    const digest = createHash('sha256').update(bytes).digest('hex'); evidenceFiles.set(digest, bytes);
    return {
    caseId: randomUUID(), split, platform: 'instagram', language, capturedAt: '2026-09-13T00:00:00.000Z',
    evidenceSha256: digest, expectedVenues,
    verification: {annotatorId: randomUUID(), verifierId: randomUUID(), verifiedAt: '2026-09-14T00:00:00.000Z', method: 'independent_identity_check'},
    reportedFailure: split === 'development', coverage: expectedVenues.length === 0 ? ['no_venue'] : expectedVenues.length > 1 ? ['multiple_places'] : [],
  };};
  const corpus = {schemaVersion: 1, corpusId: randomUUID(), kind: 'independently_labeled_real_posts', holdoutUsedForTuning: false,
    cases: [row([venue('dev')], 'development'), row([venue('one'), venue('two')]), row([], 'holdout', 'ja'), row([venue('chain')])]};
  const manifest = schema.sealCorpus(corpus);
  const predictions = {schemaVersion: 1, corpusSha256: manifest.corpusSha256, mode: 'captured_evidence', split: 'holdout', authorizedLiveRetrieval: false,
    results: corpus.cases.filter(c => c.split === 'holdout').map(c => ({caseId: c.caseId, evidenceSha256: c.evidenceSha256, sourceStatus: 'captured',
      autoSaved: [], confirmedSaved: [], requiresConfirmation: false, partial: false, attemptMetrics: []}))};
  return {corpus, manifest, predictions, venue, evidenceFiles};
}
function metric({platform = 'instagram', language = 'en', cost = .02, duration = 100} = {}) {
  let now = 0;
  const m = createMetrics({platform, language, queueMs: 10, now: () => now,
    prices: {schemaVersion: 1, asOf: '2026-09-14', currency: 'USD', rates: {fixture: {provider: 'google', billing: 'calls', usdPerCall: cost}}}});
  m.providerCall({provider: 'google', rateKey: 'fixture', outcome: 'success'}); now = duration; return m.finish('success');
}
describe('strict real-corpus importer and seal integrity', () => {
  test('round trip canonical checksums ignore object key ordering', () => {
    const {corpus, manifest} = fixture(); expect(schema.verifySeal(copy(corpus), copy(manifest))).toBe(true);
    expect(schema.checksum({a: 1, b: 2})).toBe(schema.checksum({b: 2, a: 1}));
    const changed = copy(corpus); changed.cases[1].expectedVenues[0].branchId = 'changed';
    expect(() => schema.verifySeal(changed, manifest)).toThrow('checksum');
  });
  test.each(['empty', 'contaminated', 'reported', 'evidence_duplicate', 'same_verifier', 'extra_field', 'bad_branch', 'empty_holdout'])('%s corpus fails closed', kind => {
    const {corpus} = fixture();
    if (kind === 'empty') corpus.cases = [];
    if (kind === 'contaminated') corpus.holdoutUsedForTuning = true;
    if (kind === 'reported') corpus.cases[1].reportedFailure = true;
    if (kind === 'evidence_duplicate') corpus.cases[1].evidenceSha256 = corpus.cases[0].evidenceSha256;
    if (kind === 'same_verifier') corpus.cases[0].verification.verifierId = corpus.cases[0].verification.annotatorId;
    if (kind === 'extra_field') corpus.cases[0].caption = 'private caption';
    if (kind === 'bad_branch') delete corpus.cases[0].expectedVenues[0].branchId;
    if (kind === 'empty_holdout') corpus.cases.forEach(c => {c.split = 'development';});
    expect(() => schema.sealCorpus(corpus)).toThrow();
  });
  test('rejects inspected old manifest and seals preceding verification', () => {
    const {corpus, manifest} = fixture(); manifest.holdoutUsedForTuning = true;
    expect(() => schema.verifySeal(corpus, manifest)).toThrow();
    expect(() => schema.sealCorpus(corpus, '2026-09-12T00:00:00.000Z')).toThrow('verification');
  });
  test('rejects non-string identities and UUID duplicates with different casing', () => {
    const {corpus} = fixture(); corpus.cases[1].caseId = corpus.cases[0].caseId.toUpperCase();
    expect(() => schema.validateCorpus(corpus)).toThrow('duplicate');
    const next = fixture().corpus; next.cases[0].expectedVenues[0].venueId = null;
    expect(() => schema.validateCorpus(next)).toThrow('identity');
  });
  test.each(['missing', 'duplicate', 'wrong_checksum', 'wrong_capture', 'extra_field', 'duplicate_save', 'live_without_authorization', 'mixed_live_quality'])('prediction %s fails', kind => {
    const {corpus, manifest, predictions, venue} = fixture();
    if (kind === 'missing') predictions.results.pop();
    if (kind === 'duplicate') predictions.results[1] = copy(predictions.results[0]);
    if (kind === 'wrong_checksum') predictions.corpusSha256 = '0'.repeat(64);
    if (kind === 'wrong_capture') predictions.results[0].evidenceSha256 = '0'.repeat(64);
    if (kind === 'extra_field') predictions.results[0].rawUrl = 'private';
    if (kind === 'duplicate_save') {
      predictions.results[0].autoSaved = [{...venue('one'), isNew: true}];
      predictions.results[0].confirmedSaved = copy(predictions.results[0].autoSaved);
    }
    if (kind.startsWith('live') || kind === 'mixed_live_quality') {
      predictions.mode = 'authorized_live_retrieval'; predictions.results.forEach(r => {r.sourceStatus = 'accessible';});
    }
    if (kind === 'mixed_live_quality') {predictions.authorizedLiveRetrieval = true; predictions.results[0].autoSaved = [{...venue('one'), isNew: true}];}
    expect(() => evaluateLabeledCorpus(corpus, predictions, manifest)).toThrow();
  });
});
describe('labeled quality, accessibility, latency and cost reports', () => {
  test('scores branches exactly, counts misses/no-venue false positives, and keeps unknown costs', () => {
    const {corpus, manifest, predictions, venue} = fixture();
    predictions.results[0].autoSaved = [{...venue('one'), isNew: true}];
    predictions.results[0].requiresConfirmation = true; predictions.results[0].partial = true;
    predictions.results[1].autoSaved = [{...venue('unrelated'), isNew: true}];
    predictions.results[2].autoSaved = [{...venue('chain', 'wrong-branch'), isNew: true}];
    const report = evaluateLabeledCorpus(corpus, predictions, manifest), quality = report.overall.quality;
    expect(quality.autoSavePrecision).toMatchObject({numerator: 1, denominator: 3, value: 1 / 3});
    expect(quality.wrongPlaceRate.numerator).toBe(1); expect(quality.wrongBranchRate.numerator).toBe(1);
    expect(quality.expectedVenueRecall).toMatchObject({numerator: 1, denominator: 3});
    expect(quality.missedVenues).toBe(2);
    expect(quality.noVenueFalsePositiveLinkRate).toMatchObject({numerator: 1, denominator: 1});
    expect(quality.humanConfirmationRate.denominator).toBe(3); expect(quality.partialOutcomeRate.numerator).toBe(1);
    expect(report.byLanguage.ja.quality.autoSavePrecision.value).toBe(0);
    expect(report.overall.cost.totalUsd).toBeNull(); expect(report.overall.processingMs.missing).toBe(3);
    expect(report.releaseGate.measurementReady).toBe(false);
    expect(report.releaseGate.reasons).toContain('missing_required_real_corpus_100_development_50_holdout');
    expect(report.overall.accessibility).toBeNull();
    expect(JSON.stringify(report)).not.toContain('wrong-branch');
  });
  test('sums retry cost per link, includes confirmed saves, and excludes duplicate existing saves from new denominator', () => {
    const {corpus, manifest, predictions, venue} = fixture();
    predictions.results[0].autoSaved = [{...venue('one'), isNew: false}];
    predictions.results[0].confirmedSaved = [{...venue('two'), isNew: true}];
    predictions.results[2].autoSaved = [{...venue('chain'), isNew: true}];
    predictions.results.forEach((r, i) => {r.attemptMetrics = [metric({language: i === 1 ? 'ja' : 'en'})];});
    predictions.results[0].attemptMetrics.push(metric());
    const report = evaluateLabeledCorpus(corpus, predictions, manifest);
    expect(report.overall.cost).toMatchObject({attemptedLinksDenominator: 3, correctlySavedNewPlacesDenominator: 2, totalUsd: .08});
    expect(report.overall.cost.perAttemptedLinkUsd).toBeCloseTo(.08 / 3);
    expect(report.overall.cost.perCorrectlySavedNewPlaceUsd).toBe(.04);
    expect(report.overall.processingMs).toMatchObject({p50: 100, p95: 200});
    expect(report.overall.quality.expectedVenueRecall.value).toBe(1);
    predictions.results[0].attemptMetrics[0].estimatedCost.totalUsd = 999;
    expect(evaluateLabeledCorpus(corpus, predictions, manifest).overall.cost.totalUsd).toBe(.08); // recompute, never trust totals
    predictions.results[2].attemptMetrics = predictions.results[0].attemptMetrics;
    expect(() => evaluateLabeledCorpus(corpus, predictions, manifest)).toThrow('Duplicate');
  });
  test('live accessibility is separate and a rate limit never becomes a reasoning error', () => {
    const {corpus, manifest, predictions} = fixture();
    predictions.mode = 'authorized_live_retrieval'; predictions.authorizedLiveRetrieval = true;
    predictions.results.forEach((r, i) => {r.sourceStatus = ['accessible', 'rate_limited', 'unavailable'][i];});
    const report = evaluateLabeledCorpus(corpus, predictions, manifest);
    expect(report.overall.quality).toBeNull();
    expect(report.overall.accessibility.blockedSourceRate).toMatchObject({numerator: 1, denominator: 3});
    expect(report.overall.cost.correctlySavedNewPlacesDenominator).toBeNull();
  });
  test('baseline blocks new wrong branches and flags exact 10 percent latency/cost growth', () => {
    const {corpus, manifest, predictions, venue} = fixture();
    predictions.results[0].autoSaved = [{...venue('one'), isNew: true}];
    predictions.results.forEach((r, i) => {r.attemptMetrics = [metric({language: i === 1 ? 'ja' : 'en'})];});
    const baseline = evaluateLabeledCorpus(corpus, predictions, manifest);
    predictions.results[2].autoSaved = [{...venue('chain', 'wrong-branch'), isNew: true}];
    predictions.results.forEach((r, i) => {r.attemptMetrics = [metric({language: i === 1 ? 'ja' : 'en', duration: 110, cost: .022})];});
    const report = evaluateLabeledCorpus(corpus, predictions, manifest, {baseline});
    expect(report.comparison).toMatchObject({confirmedNewWrongPlaceRegressions: 1, blockExpansion: true, investigationRequired: true});
    expect(report.comparison.changes.find(c => c.metric === 'costPerAttemptedLinkUsd').investigationRequired).toBe(true);
    expect(report.releaseGate.reasons).toContain('confirmed_new_wrong_place_or_branch_regression');
    const repeated = evaluateLabeledCorpus(corpus, predictions, manifest, {baseline: report});
    expect(repeated.comparison.confirmedNewWrongPlaceRegressions).toBe(0);
    const incompatible = copy(baseline); incompatible.corpusSha256 = '0'.repeat(64);
    expect(() => evaluateLabeledCorpus(corpus, predictions, manifest, {baseline: incompatible})).toThrow('identical corpus');
  });
  test('new wrong human-confirmed saves also block expansion', () => {
    const {corpus, manifest, predictions, venue} = fixture();
    const baseline = evaluateLabeledCorpus(corpus, predictions, manifest);
    predictions.results[0].confirmedSaved = [{...venue('wrong'), isNew: true}];
    const report = evaluateLabeledCorpus(corpus, predictions, manifest, {baseline});
    expect(report.overall.quality.confirmedSavePrecision).toMatchObject({numerator: 0, denominator: 1});
    expect(report.comparison.blockExpansion).toBe(true);
  });
});
describe('private offline CLI workflows', () => {
  let dir;
  beforeEach(() => {dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-eval-test-'));});
  afterEach(() => {fs.rmSync(dir, {recursive: true, force: true});});
  const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], {encoding: 'utf8'});
  test('strict evaluation writes reviewable report, fails missing corpus gate, and seals cannot overwrite', () => {
    const {corpus, predictions, evidenceFiles} = fixture();
    const corpusPath = path.join(dir, 'corpus.json'), sealPath = path.join(dir, 'seal.json'), predictionPath = path.join(dir, 'predictions.json'), reportPath = path.join(dir, 'report.json');
    writePrivateJson(corpusPath, corpus); writePrivateJson(predictionPath, predictions);
    for (const [digest, bytes] of evidenceFiles) fs.writeFileSync(path.join(dir, `${digest}.bin`), bytes, {mode: 0o600});
    expect(run('import-engine-corpus.js', ['--input', corpusPath, '--evidence-dir', dir, '--seal', sealPath]).status).toBe(0);
    expect(fs.statSync(sealPath).mode & 0o777).toBe(0o600);
    expect(run('import-engine-corpus.js', ['--input', corpusPath, '--evidence-dir', dir, '--seal', sealPath]).status).toBe(1);
    const result = run('evaluate-labeled-engine.js', ['--corpus', corpusPath, '--evidence-dir', dir, '--seal', sealPath, '--predictions', predictionPath, '--output', reportPath, '--strict']);
    expect(result.status).toBe(2);
    expect(JSON.parse(fs.readFileSync(reportPath)).releaseGate.measurementReady).toBe(false);
    expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain('Synthetic tests are not live evidence');
  });
  test('missing corpus and malformed private JSON fail without echoing text or path', () => {
    expect(run('evaluate-labeled-engine.js', []).status).toBe(1);
    const input = path.join(dir, 'private-user-caption.json'); fs.writeFileSync(input, '{private-caption-secret');
    const result = run('import-engine-corpus.js', ['--input', input, '--evidence-dir', dir, '--seal', path.join(dir, 'seal.json')]);
    expect(result.status).toBe(1); expect(result.stderr).not.toContain(input); expect(result.stderr).not.toContain('private-caption-secret');
  });
  test('evidence byte tampering and missing captures fail before evaluation', () => {
    const {corpus, evidenceFiles} = fixture();
    expect(() => schema.verifyEvidenceDirectory(corpus, dir)).toThrow();
    for (const [digest, bytes] of evidenceFiles) fs.writeFileSync(path.join(dir, `${digest}.bin`), bytes);
    expect(schema.verifyEvidenceDirectory(corpus, dir).checkedFiles).toBe(4);
    fs.appendFileSync(path.join(dir, `${corpus.cases[1].evidenceSha256}.bin`), 'changed');
    expect(() => schema.verifyEvidenceDirectory(corpus, dir)).toThrow('checksum');
  });
  test('operational report runs offline with private output and clear non-accuracy scope', () => {
    const input = path.join(dir, 'attempts.json'), output = path.join(dir, 'report.json');
    writePrivateJson(input, [metric()]);
    const result = run('engine-report.js', ['--input', input, '--output', output]);
    expect(result.status).toBe(0); expect(JSON.parse(fs.readFileSync(output)).quality).toBeNull();
    expect(run('import-engine-corpus.js', ['--schema']).status).toBe(0);
    expect(run('evaluate-labeled-engine.js', ['--help']).stdout).toContain('attemptMetrics');
  });
});
