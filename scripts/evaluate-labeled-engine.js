#!/usr/bin/env node
'use strict';
const {args, readJson, writePrivateJson} = require('./engine-report');
const {evaluateLabeledCorpus} = require('../lib/labeledEvaluation');
const {verifyEvidenceDirectory} = require('../lib/labeledEvaluationSchema');
function main(argv) {
  const options = args(argv, ['--corpus', '--evidence-dir', '--seal', '--predictions', '--baseline', '--output', '--strict', '--help']);
  if (options['--help']) console.log('V2 is selected by corpus.schemaVersion=2. Rehash every media asset before scoring. Predictions distinguish candidates, automaticDecisions and actual autoSaved/confirmedSaved with isolated tester attestations. Recorded replay cannot report actual saves. Analysis has plannedRefs/observedRefs for audio and frames; completion applies only to the declared policy. V2 reports explicit identifiable/ambiguous/no_venue/insufficient_capture denominators, grounding, modality/holdout gates and paired recall regressions. Compare the same execution, cache state, corpus and frozen Places digest. Unknown usage remains unknown. Replay outputs one prediction file per arm: evaluate each file separately against the baseline report.');
  if (options['--help']) {console.log(`Usage: node scripts/evaluate-labeled-engine.js --corpus private-corpus.json --evidence-dir restricted-captures --seal private-seal.json --predictions private-predictions.json --output new-private-report.json [--baseline prior-report.json] [--strict]
This scores separately generated predictions; it never calls providers or fetches posts.
Predictions require exactly: {schemaVersion:1,corpusSha256:<seal checksum>,mode:"captured_evidence"|"authorized_live_retrieval",split:"development"|"holdout",authorizedLiveRetrieval:<true only for live>,results:[...]}
Each result requires: {caseId:<corpus UUID>,evidenceSha256:<captured evidence checksum>,sourceStatus:"captured" for fixed evidence or "accessible"|"blocked"|"rate_limited"|"unavailable" for live,autoSaved:[{venueId,branchId,isNew}],confirmedSaved:[{venueId,branchId,isNew}],requiresConfirmation:<boolean>,partial:<boolean>,attemptMetrics:[<engineMetrics.finish() reports for ALL attempts including retries>]}
Use empty saves for missed/failed cases; omit no cases. Live retrieval results must have empty saves and false confirmation/partial flags; they measure accessibility only. Captured evidence files named <evidenceSha256>.bin are rehashed from --evidence-dir; the separate prediction producer must attest it used those exact bytes. Missing metrics produce unknown latency/cost. Holdout inspection for tuning contaminates the set: replace it, never relabel it blind. Output includes private case IDs; mode 0600, no overwrite. --strict exits 2 unless measurement gates pass; rollout still requires external checks. No real corpus is bundled; 100 development + 50 sealed independently verified labels remain a release gate.`); return;}
  if (['--corpus', '--evidence-dir', '--seal', '--predictions', '--output'].some(k => !options[k])) throw new Error('Missing required corpus/evidence/seal/predictions/output; real corpus is a release gate');
  const corpus = readJson(options['--corpus']);
  verifyEvidenceDirectory(corpus, options['--evidence-dir']);
  const report = evaluateLabeledCorpus(corpus, readJson(options['--predictions']), readJson(options['--seal']),
    {baseline: options['--baseline'] ? readJson(options['--baseline']) : null});
  writePrivateJson(options['--output'], report);
  console.log(`${report.sample.evaluatedCases} operator-attested cases evaluated in ${report.mode} mode. Measurement gate: ${report.releaseGate.measurementReady ? 'passed; external rollout checks remain' : 'CLOSED'}. Synthetic tests are not live evidence.`);
  if (options['--strict'] && !report.releaseGate.measurementReady) process.exitCode = 2;
}
if (require.main === module) {try {main(process.argv.slice(2));} catch (error) {
  const safe = error instanceof SyntaxError || error.code ? 'Invalid/unavailable private input or output' : error.message;
  console.error(`Labeled evaluation failed: ${safe}. Release gate remains closed.`); process.exitCode = 1;
}}
module.exports = {main};
