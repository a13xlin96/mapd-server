'use strict';

// Private evaluation contract, NOT the runtime media envelope. Times are local
// to the hashed asset (clipStartMs maps back to the original source); text ranges
// are UTF-16 offsets. The manifest hash is not a substitute for hashing its bytes.
const fs = require('fs');
const path = require('path');
const {createHash} = require('crypto');
const {PLATFORMS, LANGUAGES} = require('./engineMetrics');
const {checksum, identity} = require('./labeledEvaluationSchema');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPOSITIONS = ['identifiable', 'ambiguous', 'no_venue', 'insufficient_capture'];
const KINDS = ['caption', 'subtitles', 'audio', 'video', 'image'];
const MODALITIES = ['caption_control', 'speech_only', 'brief_sign', 'complementary', 'ambiguous_branch', 'no_venue'];
const COVERAGE = ['tags', 'branches', 'missing_caption', 'multiple_places', ...MODALITIES];
const LIMITS = Object.freeze({fileBytes: 64 * 1024 * 1024, caseBytes: 128 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, maxDurationMs: 600000, maxAssets: 64});
const fail = message => {throw new Error(message);};
const count = n => Number.isSafeInteger(n) && n >= 0;
const date = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail(`Invalid ${name}: exact fields required`);
}
function list(value, max, name) {if (!Array.isArray(value) || value.length > max) fail(`Invalid ${name}`);}
function venue(v, saved = false) {
  exact(v, saved ? ['venueId', 'branchId', 'isNew'] : ['venueId', 'branchId'], 'venue');
  if (typeof v.venueId !== 'string' || !ID.test(v.venueId) || typeof v.branchId !== 'string' || !ID.test(v.branchId) || (saved && typeof v.isNew !== 'boolean')) fail('Invalid venue identity');
}
function venues(values, saved = false) {
  list(values, 40, 'venues'); values.forEach(v => venue(v, saved));
  if (new Set(values.map(identity)).size !== values.length) fail('Duplicate venue identity');
}
function validateAssets(assets) {
  list(assets, LIMITS.maxAssets, 'assets');
  if (!assets.length) fail('Captured assets required');
  const ids = new Set();
  for (const a of assets) {
    exact(a, ['assetId', 'kind', 'sha256', 'byteLength', 'durationMs', 'clipStartMs', 'language', 'provenance', 'textLength'], 'asset');
    if (typeof a.assetId !== 'string' || !ID.test(a.assetId) || ids.has(a.assetId) || !KINDS.includes(a.kind) || typeof a.sha256 !== 'string' || !SHA.test(a.sha256)) fail('Invalid/duplicate asset identity');
    if (!count(a.byteLength) || !a.byteLength || a.byteLength > LIMITS.fileBytes || !count(a.clipStartMs) || a.clipStartMs > 86400000) fail('Invalid asset size/offset');
    const timed = ['audio', 'video', 'subtitles'].includes(a.kind), text = ['caption', 'subtitles'].includes(a.kind);
    if (timed ? !count(a.durationMs) || !a.durationMs || a.durationMs > LIMITS.maxDurationMs : a.durationMs !== null) fail('Invalid asset duration');
    if (text ? !count(a.textLength) || !a.textLength || a.textLength > 1000000 : a.textLength !== null) fail('Invalid asset text length');
    if (!LANGUAGES.includes(a.language) || !['captured_original', 'derived_capture'].includes(a.provenance)) fail('Invalid asset provenance');
    ids.add(a.assetId);
  }
  if (assets.reduce((n, a) => n + a.byteLength, 0) > LIMITS.caseBytes) fail('Captured case asset byte limit exceeded');
  return assets;
}
/** EvidenceRef = {assetId, modality:'text'|'audio'|'frame', intervalMs:[start,end]|null, textRange:[start,end]|null,
 * region:[left,top,right,bottom]|null}. Video point intervals represent frames.
 * Structural validity is distinct from independently annotated semantic support. */
function validateRef(ref, assets) {
  exact(ref, ['assetId', 'modality', 'intervalMs', 'textRange', 'region'], 'evidence reference');
  const a = assets.find(v => v.assetId === ref.assetId);
  if (!a) fail('Unknown evidence asset');
  const modalities = {caption: ['text'], subtitles: ['text'], audio: ['audio'], video: ['audio', 'frame'], image: ['frame']};
  if (!modalities[a.kind].includes(ref.modality)) fail('Evidence modality disagrees with captured asset');
  const range = (r, limit, point = false) => Array.isArray(r) && r.length === 2 && r.every(count) && (point ? r[0] <= r[1] : r[0] < r[1]) && r[1] <= limit;
  if (a.durationMs !== null ? !range(ref.intervalMs, a.durationMs, ref.modality === 'frame') : ref.intervalMs !== null) fail('Invalid evidence timing');
  if (a.textLength !== null ? !range(ref.textRange, a.textLength) : ref.textRange !== null) fail('Invalid evidence text offsets');
  if (ref.region !== null && (ref.modality !== 'frame' || !Array.isArray(ref.region) || ref.region.length !== 4 || ref.region.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || ref.region[0] >= ref.region[2] || ref.region[1] >= ref.region[3])) fail('Invalid evidence region');
  return ref;
}
function refs(values, assets, min = 0) {
  list(values, 64, 'evidence references');
  if (values.length < min) fail('Missing supporting evidence');
  values.forEach(r => validateRef(r, assets));
  if (new Set(values.map(checksum)).size !== values.length) fail('Duplicate evidence reference');
}
function validateCorpusV2(corpus) {
  exact(corpus, ['schemaVersion', 'corpusId', 'kind', 'holdoutUsedForTuning', 'cases'], 'corpus');
  if (corpus.schemaVersion !== 2 || typeof corpus.corpusId !== 'string' || !UUID.test(corpus.corpusId) || corpus.kind !== 'independently_labeled_real_posts' || typeof corpus.holdoutUsedForTuning !== 'boolean') fail('Invalid real corpus provenance');
  list(corpus.cases, 10000, 'corpus cases'); if (!corpus.cases.length) fail('Empty corpus');
  const ids = new Set(), manifests = new Set(), splitKeys = new Map();
  const splitKey = (key, split) => {
    if (splitKeys.has(key) && splitKeys.get(key) !== split) fail('Cross-split source/venue/asset family leakage');
    splitKeys.set(key, split);
  };
  for (const r of corpus.cases) {
    exact(r, ['caseId', 'split', 'platform', 'language', 'capturedAt', 'evidenceSha256', 'expectedVenues', 'verification', 'reportedFailure', 'coverage', 'familyId', 'disposition', 'assets', 'supports'], 'v2 corpus case');
    if (typeof r.caseId !== 'string' || !UUID.test(r.caseId) || ids.has(r.caseId.toLowerCase()) || typeof r.familyId !== 'string' || !ID.test(r.familyId)) fail('Invalid/duplicate case or family ID');
    if (!['development', 'holdout'].includes(r.split) || !PLATFORMS.includes(r.platform) || !LANGUAGES.includes(r.language) || !date(r.capturedAt)) fail('Invalid case labels');
    if (typeof r.reportedFailure !== 'boolean' || (r.reportedFailure && r.split === 'holdout')) fail('Reported failures belong in development');
    if (!DISPOSITIONS.includes(r.disposition)) fail('Invalid disposition');
    list(r.coverage, COVERAGE.length, 'coverage labels');
    if (new Set(r.coverage).size !== r.coverage.length || r.coverage.some(k => !COVERAGE.includes(k))) fail('Invalid coverage labels');
    venues(r.expectedVenues); validateAssets(r.assets);
    if (r.disposition === 'identifiable' ? !r.expectedVenues.length : r.expectedVenues.length !== 0) fail('Disposition disagrees with unique expected venues');
    if (r.coverage.includes('no_venue') !== (r.disposition === 'no_venue') || r.coverage.includes('multiple_places') !== (r.expectedVenues.length > 1)) fail('Coverage disagrees with disposition');
    if (r.coverage.includes('ambiguous_branch') && r.disposition !== 'ambiguous') fail('Ambiguous branch label disagrees');
    if (r.coverage.includes('speech_only') && !r.assets.some(a => ['audio', 'video'].includes(a.kind))) fail('Speech-only requires captured media');
    if (r.coverage.includes('brief_sign') && !r.assets.some(a => ['video', 'image'].includes(a.kind))) fail('Brief-sign requires captured visual media');
    if (r.evidenceSha256 !== checksum(r.assets) || manifests.has(r.evidenceSha256)) fail('Invalid/duplicate asset manifest checksum');
    exact(r.verification, ['annotatorId', 'verifierId', 'verifiedAt', 'method'], 'independent verification');
    const v = r.verification;
    if (!UUID.test(v.annotatorId) || !UUID.test(v.verifierId) || v.annotatorId.toLowerCase() === v.verifierId.toLowerCase() || !date(v.verifiedAt) || Date.parse(v.verifiedAt) < Date.parse(r.capturedAt) || v.method !== 'independent_identity_check') fail('Independent verification attestation required');
    list(r.supports, 40, 'private supports');
    if (r.supports.length !== r.expectedVenues.length || new Set(r.supports.map(identity)).size !== r.supports.length) fail('One support annotation per identifiable venue required');
    for (const s of r.supports) {
      exact(s, ['venueId', 'branchId', 'nameRefs', 'branchRefs'], 'private support');
      if (!r.expectedVenues.some(v => identity(v) === identity(s))) fail('Support for unknown venue');
      refs(s.nameRefs, r.assets, 1); refs(s.branchRefs, r.assets, 1);
    }
    splitKey(`family:${r.familyId}`, r.split);
    r.expectedVenues.forEach(v => splitKey(`venue:${v.venueId}`, r.split));
    r.assets.forEach(a => splitKey(`asset:${a.sha256}`, r.split));
    ids.add(r.caseId.toLowerCase()); manifests.add(r.evidenceSha256);
  }
  return corpus;
}
/** Stream and hash content-addressed regular files with explicit video byte
 * bounds. No symlinks, URLs, subprocesses or content logging; check text offsets
 * against actual decoded bytes. Returns counts only, never private content. */
function verifyAssetRows(rows, directory) {
  if (typeof directory !== 'string' || !directory) fail('Restricted asset directory required');
  const checked = new Map(), buffer = Buffer.alloc(65536); let bytes = 0;
  for (const row of rows) for (const asset of validateAssets(row.assets)) {
    const prior = checked.get(asset.sha256);
    if (prior) {if (['kind', 'byteLength', 'textLength', 'durationMs'].some(k => prior[k] !== asset[k])) fail('Conflicting asset descriptions'); continue;}
    const fd = fs.openSync(path.join(directory, `${asset.sha256}.bin`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size !== asset.byteLength || st.size > LIMITS.fileBytes) fail('Asset size mismatch');
      const hash = createHash('sha256'), chunks = []; let size = 0, n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        size += n; bytes += n;
        if (size > asset.byteLength || bytes > LIMITS.totalBytes) fail('Asset input size limit exceeded');
        hash.update(buffer.subarray(0, n)); if (asset.textLength !== null) chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      if (size !== st.size || hash.digest('hex') !== asset.sha256) fail('Captured asset bytes/checksum mismatch');
      if (asset.textLength !== null) {
        const data = Buffer.concat(chunks), text = new TextDecoder('utf-8', {fatal: true}).decode(data);
        if (text.length !== asset.textLength) fail('Text offsets do not match captured asset');
      }
    } finally {fs.closeSync(fd);}
    checked.set(asset.sha256, asset);
  }
  return {checkedFiles: checked.size, bytes};
}
function verifyAssets(corpus, directory) {validateCorpusV2(corpus); return verifyAssetRows(corpus.cases, directory);}
// Minimal machine-readable structural contract; cross-field hash/family/support
// constraints above are authoritative. v1 --schema remains byte-for-byte stable.
const string = {type: 'string'}, nullable = type => ({type: [type, 'null']});
const obj = properties => ({type: 'object', additionalProperties: false, required: Object.keys(properties), properties});
const arr = items => ({type: 'array', items});
const refSchema = obj({assetId: string, modality: {enum: ['text', 'audio', 'frame']}, intervalMs: nullable('array'), textRange: nullable('array'), region: nullable('array')});
const assetSchema = obj({assetId: string, kind: {enum: KINDS}, sha256: {type: 'string', pattern: SHA.source}, byteLength: {type: 'integer', minimum: 1, maximum: LIMITS.fileBytes}, durationMs: nullable('integer'), clipStartMs: {type: 'integer', minimum: 0}, language: {enum: LANGUAGES}, provenance: {enum: ['captured_original', 'derived_capture']}, textLength: nullable('integer')});
const corpusSchemaV2 = {$schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({schemaVersion: {const: 2}, corpusId: string, kind: {const: 'independently_labeled_real_posts'}, holdoutUsedForTuning: {type: 'boolean'}, cases: arr(obj({caseId: string, split: {enum: ['development', 'holdout']}, platform: {enum: PLATFORMS}, language: {enum: LANGUAGES}, capturedAt: string, evidenceSha256: string, expectedVenues: arr(obj({venueId: string, branchId: string})), verification: obj({annotatorId: string, verifierId: string, verifiedAt: string, method: {const: 'independent_identity_check'}}), reportedFailure: {type: 'boolean'}, coverage: arr({enum: COVERAGE}), familyId: string, disposition: {enum: DISPOSITIONS}, assets: arr(assetSchema), supports: arr(obj({venueId: string, branchId: string, nameRefs: arr(refSchema), branchRefs: arr(refSchema)}))}))})};
module.exports = {UUID, SHA, ID, DISPOSITIONS, MODALITIES, COVERAGE, LIMITS, exact, list, count, date, venue, venues, refs, validateRef, validateAssets, validateCorpusV2, verifyAssets, verifyAssetRows, corpusSchemaV2};
