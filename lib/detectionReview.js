'use strict';

const {createHash} = require('crypto');
const {normalizePlaceName} = require('./placeNameNormalize');
const {isAnalysisRecovery, RECOVERY} = require('./media/analysisRecovery');
const MAX_OUTCOMES = 160;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function text(value, max) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function clueKey(outcome) {
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '';
  return digest([...['name', 'city', 'country', 'address'].map(k => normalize(outcome[k])),
    ...['placeId', 'confirmedPlaceId', 'pinId'].map(k => outcome[k] ?? '')]);
}
function isReviewedDismissal(outcome) {
  return outcome?.status === 'dismissed' && outcome.review?.schema === 1 &&
    outcome.review.kind === 'detection_review' && ['same_place', 'dismiss'].includes(outcome.review.action) &&
    outcome.review.clueKey === clueKey(outcome);
}
function reviewedClueMatches(dismissed, clue) {
  return isReviewedDismissal(dismissed) && typeof clue?.name === 'string' && clue.name.trim().length > 0 &&
    dismissed.review.clueKey === clueKey(clue);
}
class DetectionReviewError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status = 400) => { throw new DetectionReviewError(code, status); };
function reviewRevision(job) {
  const revision = job.detectionReview?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER - 1) fail('review_unavailable', 409);
  return revision;
}
function validateRequest(body) {
  if (!object(body) || !id(body.jobId)) fail('invalid_review');
  const mutation = Object.hasOwn(body, 'version') || Object.hasOwn(body, 'decisions');
  const allowed = mutation ? ['jobId', 'version', 'decisions'] : ['jobId'];
  if (Object.keys(body).some(k => !allowed.includes(k))) fail('invalid_review');
  if (!mutation) return {jobId: body.jobId};
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) ||
      !Array.isArray(body.decisions) || !body.decisions.length || body.decisions.length > MAX_OUTCOMES) fail('invalid_review');
  const seen = new Set();
  for (const decision of body.decisions) {
    if (!object(decision) || Object.keys(decision).some(k => !['outcomeId', 'action', 'savedPlaceId'].includes(k)) ||
        !id(decision.outcomeId) || seen.has(decision.outcomeId) || !['same_place', 'dismiss'].includes(decision.action) ||
        (Object.hasOwn(decision, 'savedPlaceId') && (decision.action !== 'same_place' || !id(decision.savedPlaceId)))) fail('invalid_review');
    seen.add(decision.outcomeId);
  }
  return {...body, decisions: [...body.decisions].sort((a, b) => a.outcomeId.localeCompare(b.outcomeId))};
}
function assertJob(job, userId) {
  if (!job || job.userId !== userId) fail('access_blocked', 403);
  const outcomes = job.outcomes;
  if (job.engineVersion?.schema !== 2 || !Array.isArray(outcomes) || !outcomes.length || outcomes.length > MAX_OUTCOMES ||
      outcomes.some(o => !object(o) || !['saved', 'existing', 'unresolved', 'dismissed'].includes(o.status))) fail('review_unavailable', 409);
  const saved = savedCount(outcomes);
  const pending = outcomes.filter(o => o.status === 'unresolved');
  const unresolved = pending.length;
  // Mobile receipts support at most 100 known places. Never return a preview
  // the client cannot persist, or silently omit malformed unresolved clues.
  if (pending.some(o => !text(o.name, 200)) || saved + unresolved > 100) fail('review_unavailable', 409);
  const partial = job.status === 'failed' && job.failure?.code === 'partial_save' && saved > 0 && unresolved > 0;
  const reviewed = job.status === 'complete' && saved > 0 && !unresolved && job.detectionReview?.schema === 1 &&
    outcomes.some(isReviewedDismissal);
  if (!partial && !reviewed) fail('review_unavailable', 409);
}
const committed = o => ['saved', 'existing'].includes(o.status);
// Prefer the canonical place ID; legacy committed receipts can have only a
// pin ID. Union both keys so duplicate receipts never inflate the count.
function savedCount(outcomes) {
  const groups = [];
  for (const outcome of outcomes.filter(committed)) {
    const keys = [id(outcome.placeId) && `place:${outcome.placeId}`, id(outcome.pinId) && `pin:${outcome.pinId}`].filter(Boolean);
    if (!keys.length) fail('review_unavailable', 409);
    const matching = groups.filter(group => keys.some(key => group.has(key)));
    const group = new Set([...keys, ...matching.flatMap(group => [...group])]);
    for (const match of matching) groups.splice(groups.indexOf(match), 1);
    groups.push(group);
  }
  return groups.length;
}
function suggestedOutcome(clue, outcomes) {
  if ([clue.placeId, clue.confirmedPlaceId, clue.pinId].some(v => v != null && v !== '') ||
      /save|attach|persist/i.test(`${clue.failure?.stage || ''} ${clue.failure?.code || ''}`)) return null;
  const ranked = clue.ranking?.candidates;
  if (!Array.isArray(ranked) || ranked.length !== 1 || !id(ranked[0]?.placeId)) return null;
  const name = typeof clue.name === 'string' ? normalizePlaceName(clue.name) : '';
  if (!name) return null;
  const matches = outcomes.filter(o => committed(o) && o.placeId === ranked[0].placeId && id(o.pinId) &&
    typeof o.name === 'string' && normalizePlaceName(o.name) === name);
  const identities = new Set(matches.map(o => o.pinId));
  return identities.size === 1 ? matches[0] : null;
}
async function readPins(txn, db, job) {
  const pins = new Map();
  for (const pinId of [...new Set(job.outcomes.filter(committed).map(o => o.pinId).filter(id))].sort()) {
    const snap = await txn.get(db.collection('pins').doc(pinId));
    const pin = snap.data();
    // Include raw identity/geography in the fingerprint, not truncated display
    // strings. Creation time also distinguishes a deleted/recreated pin.
    pins.set(pinId, pin ? {pinId, createdAt: snap.createTime || null,
      ...Object.fromEntries(['userId', 'placeId', 'placeName', 'formattedAddress', 'address', 'city', 'country', 'latitude', 'longitude']
        .map(k => [k, pin[k] ?? null]))} : null);
  }
  return pins;
}
function snapshot(jobId, job, pins) {
  const revision = reviewRevision(job);
  const version = digest({jobId, revision, ...Object.fromEntries(['userId', 'url', 'status', 'outcomes', 'progress', 'failure', 'error',
    'engineVersion', 'createdAt', 'workerOwner', 'engineDeadline', 'retryOf', 'retryKind', 'selectedPlaceIds', 'analysisRecovery']
    .map(k => [k, job[k] ?? null])), pins: [...pins]});
  const items = job.outcomes.flatMap((clue, index) => {
    if (clue.status !== 'unresolved') return [];
    const item = {outcomeId: `clue_${index}_${digest(clue)}`, name: text(clue.name, 200),
      city: text(clue.city, 200), address: text(clue.address, 500)};
    const suggestion = suggestedOutcome(clue, job.outcomes);
    const pin = suggestion && pins.get(suggestion.pinId);
    if (pin?.userId === job.userId && pin.placeId === suggestion.placeId && typeof pin.placeName === 'string' &&
        normalizePlaceName(pin.placeName) === normalizePlaceName(clue.name)) {
      item.savedPlace = {placeId: pin.placeId, pinId: pin.pinId, name: text(pin.placeName, 200),
        address: text(pin.formattedAddress || pin.address, 500), city: text(pin.city, 200)};
    }
    return [item];
  });
  return {version, revision, savedCount: savedCount(job.outcomes), unresolvedCount: items.length,
    completed: job.status === 'complete' && !items.length,
    analysisRecovery: isAnalysisRecovery(job.analysisRecovery) ? {...RECOVERY} : null, items};
}

/** Read and decide under one transaction. The sole write is the job document;
 * no pin, source, counter, provider, or worker dependency belongs here. */
async function reviewDetections(db, userId, body, {now = Date.now, serverTimestamp = () => new Date()} = {}) {
  const request = validateRequest(body);
  if (typeof userId !== 'string' || !userId) fail('access_blocked', 403);
  if (!db) fail('review_unavailable', 503);
  return db.runTransaction(async txn => {
    const ref = db.collection('enrichmentJobs').doc(request.jobId);
    const job = (await txn.get(ref)).data();
    assertJob(job, userId);
    const pins = await readPins(txn, db, job);
    const preview = snapshot(request.jobId, job, pins);
    if (!request.decisions) return preview;
    const requestHash = digest(request);
    // A delivery retry is valid only while the *entire resulting state* still
    // matches. Never apply an old tap to new work, even at the same array index.
    if (job.detectionReview?.requestHash === requestHash && job.detectionReview.resultVersion === preview.version) return preview;
    if (request.version !== preview.version) fail('review_conflict', 409);
    const decisions = new Map();
    for (const decision of request.decisions) {
      const item = preview.items.find(item => item.outcomeId === decision.outcomeId);
      if (!item || (decision.action === 'same_place' && (!item.savedPlace ||
          (decision.savedPlaceId !== undefined && decision.savedPlaceId !== item.savedPlace.placeId)))) fail('invalid_decision');
      decisions.set(item.outcomeId, {decision, item});
    }
    const reviewedAt = now();
    const outcomes = job.outcomes.map((outcome, index) => {
      const chosen = decisions.get(`clue_${index}_${digest(outcome)}`);
      if (!chosen) return outcome;
      return {...outcome, status: 'dismissed', review: {schema: 1, kind: 'detection_review', action: chosen.decision.action,
        clueKey: clueKey(outcome), version: request.version, reviewedAt,
        ...(chosen.decision.action === 'same_place' ? {savedPlaceId: chosen.item.savedPlace.placeId, pinId: chosen.item.savedPlace.pinId} : {})}};
    });
    const saved = savedCount(outcomes);
    const unresolved = outcomes.filter(o => o.status === 'unresolved').length;
    const total = saved + unresolved;
    const update = {outcomes, progress: {saved, total}, unresolvedCount: unresolved, status: unresolved ? 'failed' : 'complete',
      failure: unresolved ? {code: 'partial_save', stage: 'places', provider: 'engine',
        message: `Saved ${saved} of ${total} places. Retry the remaining places or dismiss.`, requiresUserAction: true} : null,
      error: unresolved ? 'Some places remain unresolved' : null};
    const revision = preview.revision + 1;
    const result = snapshot(request.jobId, {...job, ...update, detectionReview: {schema: 1, revision}}, pins);
    // Discovery timestamp is deliberately outside snapshot(): its resolved
    // server value is unavailable until commit and must not break redelivery.
    txn.update(ref, {...update, updatedAt: serverTimestamp(), detectionReview: {schema: 1, revision, requestHash, resultVersion: result.version}});
    return result;
  });
}

module.exports = {reviewDetections, DetectionReviewError, isReviewedDismissal, reviewedClueMatches};
