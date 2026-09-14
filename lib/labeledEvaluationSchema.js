'use strict';

// These files belong in restricted storage. IDs refer to independently checked
// venue AND branch identities; no fuzzy name comparison is used for scoring.
const {createHash} = require('crypto');
const fs = require('fs');
const path = require('path');
const {PLATFORMS, LANGUAGES} = require('./engineMetrics');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const COVERAGE = ['tags', 'branches', 'missing_caption', 'multiple_places', 'no_venue'];
const fail = message => {throw new Error(message);};
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail(`Invalid ${name}: exact fields required`);
}
function date(value) {return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const checksum = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = venue => `${venue.venueId}:${venue.branchId}`;
function validateVenues(venues, saved = false) {
  if (!Array.isArray(venues) || venues.length > 40) fail('Invalid venue list');
  const seen = new Set();
  for (const venue of venues) {
    object(venue, saved ? ['venueId', 'branchId', 'isNew'] : ['venueId', 'branchId'], 'venue');
    if (typeof venue.venueId !== 'string' || typeof venue.branchId !== 'string' || !ID.test(venue.venueId) || !ID.test(venue.branchId) || (saved && typeof venue.isNew !== 'boolean')) fail('Invalid venue identity');
    const key = identity(venue);
    if (seen.has(key)) fail('Duplicate venue identity');
    seen.add(key);
  }
}
function validateCorpus(corpus) {
  object(corpus, ['schemaVersion', 'corpusId', 'kind', 'holdoutUsedForTuning', 'cases'], 'corpus');
  if (corpus.schemaVersion !== 1 || !UUID.test(corpus.corpusId) || corpus.kind !== 'independently_labeled_real_posts' || typeof corpus.holdoutUsedForTuning !== 'boolean') fail('Invalid real corpus provenance');
  if (!Array.isArray(corpus.cases) || !corpus.cases.length || corpus.cases.length > 10000) fail('Corpus must contain 1..10000 independently labeled cases');
  const ids = new Set(), evidence = new Set();
  for (const row of corpus.cases) {
    object(row, ['caseId', 'split', 'platform', 'language', 'capturedAt', 'evidenceSha256', 'expectedVenues', 'verification', 'reportedFailure', 'coverage'], 'corpus case');
    if (!UUID.test(row.caseId) || ids.has(row.caseId.toLowerCase())) fail('Invalid or duplicate case ID');
    if (!['development', 'holdout'].includes(row.split) || !PLATFORMS.includes(row.platform) || !LANGUAGES.includes(row.language) || !date(row.capturedAt)) fail('Invalid case labels');
    if (!SHA.test(row.evidenceSha256) || evidence.has(row.evidenceSha256)) fail('Invalid or duplicate captured evidence checksum');
    if (typeof row.reportedFailure !== 'boolean' || (row.reportedFailure && row.split === 'holdout')) fail('Reported failures belong in development, never sealed holdout');
    if (!Array.isArray(row.coverage) || new Set(row.coverage).size !== row.coverage.length || row.coverage.some(k => !COVERAGE.includes(k))) fail('Invalid coverage labels');
    validateVenues(row.expectedVenues);
    if (row.coverage.includes('no_venue') !== (row.expectedVenues.length === 0) || row.coverage.includes('multiple_places') !== (row.expectedVenues.length > 1)) fail('Coverage disagrees with expected venues');
    object(row.verification, ['annotatorId', 'verifierId', 'verifiedAt', 'method'], 'independent verification');
    const v = row.verification;
    if (!UUID.test(v.annotatorId) || !UUID.test(v.verifierId) || v.annotatorId.toLowerCase() === v.verifierId.toLowerCase() || !date(v.verifiedAt) || Date.parse(v.verifiedAt) < Date.parse(row.capturedAt) || v.method !== 'independent_identity_check') fail('Independent verification attestation required');
    ids.add(row.caseId.toLowerCase()); evidence.add(row.evidenceSha256);
  }
  return corpus;
}
function verifyEvidenceDirectory(corpus, directory) {
  validateCorpus(corpus);
  if (typeof directory !== 'string' || !directory) fail('Restricted captured evidence directory required');
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (const row of corpus.cases) {
    // Content-addressed filenames have no raw URL or private post text. Hash the
    // exact bytes, not parsed/reformatted JSON. No evidence content is returned.
    const fd = fs.openSync(path.join(directory, `${row.evidenceSha256}.bin`), 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > 16 * 1024 * 1024) fail('Evidence must be a nonempty file at most 16 MiB');
      const hash = createHash('sha256'); let size = 0, n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        size += n; bytes += n;
        if (size > 16 * 1024 * 1024 || bytes > 512 * 1024 * 1024) fail('Evidence input size limit exceeded');
        hash.update(buffer.subarray(0, n));
      }
      if (size !== stat.size || hash.digest('hex') !== row.evidenceSha256) fail('Captured evidence bytes/checksum mismatch');
    } finally {fs.closeSync(fd);}
  }
  return {checkedFiles: corpus.cases.length, bytes};
}
function sealCorpus(corpus, sealedAt = new Date().toISOString()) {
  validateCorpus(corpus);
  if (corpus.holdoutUsedForTuning) fail('Contaminated holdout: replace it before evaluation');
  const holdout = corpus.cases.filter(c => c.split === 'holdout');
  if (!holdout.length) fail('Empty holdout cannot be sealed');
  if (!date(sealedAt) || corpus.cases.some(c => Date.parse(c.verification.verifiedAt) > Date.parse(sealedAt))) fail('Seal must follow label verification');
  return {schemaVersion: 1, corpusId: corpus.corpusId, corpusSha256: checksum(corpus),
    developmentSha256: checksum(corpus.cases.filter(c => c.split === 'development')), holdoutSha256: checksum(holdout),
    holdoutCount: holdout.length, sealedAt, holdoutUsedForTuning: false};
}
function verifySeal(corpus, manifest) {
  object(manifest, ['schemaVersion', 'corpusId', 'corpusSha256', 'developmentSha256', 'holdoutSha256', 'holdoutCount', 'sealedAt', 'holdoutUsedForTuning'], 'seal');
  const expected = sealCorpus(corpus, manifest.sealedAt);
  if (canonical(expected) !== canonical(manifest)) fail('Corpus/seal checksum mismatch or contaminated holdout');
  return true;
}
function validatePredictions(predictions, corpus, manifest) {
  verifySeal(corpus, manifest);
  object(predictions, ['schemaVersion', 'corpusSha256', 'mode', 'split', 'authorizedLiveRetrieval', 'results'], 'predictions');
  if (predictions.schemaVersion !== 1 || predictions.corpusSha256 !== manifest.corpusSha256 || !['captured_evidence', 'authorized_live_retrieval'].includes(predictions.mode) || !['development', 'holdout'].includes(predictions.split)) fail('Invalid predictions version/corpus/mode/split');
  const live = predictions.mode === 'authorized_live_retrieval';
  if (predictions.authorizedLiveRetrieval !== live) fail('Live retrieval requires explicit authorization attestation; captured runs cannot claim it');
  const selected = corpus.cases.filter(c => c.split === predictions.split), byId = new Map(selected.map(c => [c.caseId, c]));
  if (!selected.length || !Array.isArray(predictions.results) || predictions.results.length !== selected.length) fail('Every case in a nonempty split needs exactly one result, including failures');
  const seen = new Set(), reports = new Set();
  for (const result of predictions.results) {
    object(result, ['caseId', 'evidenceSha256', 'sourceStatus', 'autoSaved', 'confirmedSaved', 'requiresConfirmation', 'partial', 'attemptMetrics'], 'prediction result');
    const row = byId.get(result.caseId);
    if (!row || seen.has(result.caseId) || result.evidenceSha256 !== row.evidenceSha256) fail('Unknown/duplicate case or evidence checksum mismatch');
    if (!(live ? ['accessible', 'blocked', 'rate_limited', 'unavailable'] : ['captured']).includes(result.sourceStatus)) fail('Source status disagrees with evaluation mode');
    validateVenues(result.autoSaved, true); validateVenues(result.confirmedSaved, true);
    const saved = [...result.autoSaved, ...result.confirmedSaved];
    if (new Set(saved.map(identity)).size !== saved.length) fail('Duplicate save across automatic and confirmed outputs');
    if (typeof result.requiresConfirmation !== 'boolean' || typeof result.partial !== 'boolean' || !Array.isArray(result.attemptMetrics) || result.attemptMetrics.length > 100) fail('Invalid result flags/metrics');
    if (live && (saved.length || result.requiresConfirmation || result.partial)) fail('Live retrieval reports accessibility only; evaluate reasoning on captured evidence separately');
    for (const metric of result.attemptMetrics) {
      if (reports.has(metric.reportId) || metric.platform !== row.platform || metric.language !== row.language) fail('Duplicate or misattributed attempt metrics');
      reports.add(metric.reportId);
    }
    seen.add(result.caseId);
  }
  return predictions;
}
// Machine-readable schema plus the stronger cross-field/checksum checks above.
const str = pattern => ({type: 'string', pattern: pattern.source});
const obj = properties => ({type: 'object', additionalProperties: false, required: Object.keys(properties), properties});
const venueSchema = obj({venueId: str(ID), branchId: str(ID)});
const corpusSchema = {$schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({
  schemaVersion: {const: 1}, corpusId: str(UUID), kind: {const: 'independently_labeled_real_posts'}, holdoutUsedForTuning: {type: 'boolean'},
  cases: {type: 'array', minItems: 1, maxItems: 10000, items: obj({
    caseId: str(UUID), split: {enum: ['development', 'holdout']}, platform: {enum: PLATFORMS}, language: {enum: LANGUAGES},
    capturedAt: {type: 'string', format: 'date-time'}, evidenceSha256: str(SHA), expectedVenues: {type: 'array', maxItems: 40, items: venueSchema},
    verification: obj({annotatorId: str(UUID), verifierId: str(UUID), verifiedAt: {type: 'string', format: 'date-time'}, method: {const: 'independent_identity_check'}}),
    reportedFailure: {type: 'boolean'}, coverage: {type: 'array', uniqueItems: true, items: {enum: COVERAGE}},
  })},
})};
module.exports = {COVERAGE, canonical, checksum, identity, validateCorpus, verifyEvidenceDirectory, sealCorpus, verifySeal, validatePredictions, corpusSchema};
