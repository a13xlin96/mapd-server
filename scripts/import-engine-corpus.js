#!/usr/bin/env node
'use strict';
const {args, readJson, writePrivateJson} = require('./engine-report');
const {validateCorpus, verifyEvidenceDirectory, sealCorpus, corpusSchema} = require('../lib/labeledEvaluationSchema');
function main(argv) {
  const options = args(argv, ['--input', '--evidence-dir', '--seal', '--schema', '--help']);
  if (options['--schema']) {console.log(JSON.stringify(corpusSchema, null, 2)); return;}
  if (options['--help']) {console.log('Usage: node scripts/import-engine-corpus.js --input restricted-real-corpus.json --evidence-dir restricted-captures --seal new-private-seal.json\nUse --schema for the strict corpus JSON schema. Captures are exact-byte files named <evidenceSha256>.bin inside --evidence-dir (nonempty, at most 16 MiB each/512 MiB total); every digest is verified before sealing. Input stays in restricted storage; only its checksum manifest is written (0600, no overwrite). Cases require distinct annotator/verifier UUIDs, captured evidence SHA-256, independently checked venueId/branchId labels and development/holdout split. Reported failures must be development cases. Declared contaminated or empty holdouts fail. Seal before evaluation; do not expose holdout labels for tuning. No data is fabricated or retrieved.'); return;}
  if (!options['--input'] || !options['--evidence-dir'] || !options['--seal']) throw new Error('Missing real corpus/evidence: release gate requires 100 development and 50 sealed independently verified labels');
  const corpus = validateCorpus(readJson(options['--input']));
  verifyEvidenceDirectory(corpus, options['--evidence-dir']);
  writePrivateJson(options['--seal'], sealCorpus(corpus));
  const development = corpus.cases.filter(c => c.split === 'development').length, holdout = corpus.cases.length - development;
  console.log(`Validated operator attestations and sealed checksums: ${development} development / ${holdout} holdout. ${development < 100 || holdout < 50 ? 'RELEASE GATE: insufficient real corpus.' : 'Independent provenance and holdout custody still require external review.'}`);
}
if (require.main === module) {try {main(process.argv.slice(2));} catch (error) {
  // Validator messages describe fields, never label/evidence values. Filesystem
  // and JSON parser messages can contain private paths/text, so suppress them.
  const safe = error instanceof SyntaxError || error.code ? 'Invalid/unavailable private input or output' : error.message;
  console.error(`Corpus import failed: ${safe}. Release gate remains closed.`); process.exitCode = 1;
}}
module.exports = {main};
