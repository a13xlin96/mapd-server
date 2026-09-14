'use strict';

const { createHash } = require('node:crypto');

const SCHEMA_VERSION = 1;
const FEATURE_VERSIONS = Object.freeze({
  projectionReader: 'projection-v2',
  contentIndexReader: 'content-index-v1',
  queuePolicy: 'fair-queue-v1',
  languageRouting: 'multilingual-v1',
  selectionContract: 'selection-v2',
});
const FEATURES = Object.keys(FEATURE_VERSIONS);
const COHORT_FEATURES = FEATURES.filter(key => !['queuePolicy', 'selectionContract'].includes(key));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validUid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
const validVersion = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value);

function freezeSnapshot(snapshot) {
  Object.freeze(snapshot.versions);
  return Object.freeze(snapshot);
}

/**
 * Server-only configuration; never pass req.body or a client-writable config.
 * Missing config keeps every optional feature off and normal admission open.
 * Invalid explicit config throws, so a typo cannot silently expand a rollout.
 *
 * {version:'2026-09-14.1', cohortSalt:'mapd-cohort-v1', internalUids:['...'],
 *  rolloutPercent:5, flags:{contentIndexReader:true},
 *  admission:{stopNewJobs:false}}
 *
 * rolloutPercent is 0 (internal only), 5, 25, or 100. Keep cohortSalt stable
 * through expansion. selectionContract describes the already-shipped v2
 * server capability, not an optional cohort behavior. F7 client recovery ships
 * through the app release; turning a flag off must not revive automatic modals
 * or downgrade idempotent confirmations. queuePolicy is NOT a cohort flag: the second argument
 * records the fleet scheduler independently of UID/cohort (see runtime contract).
 * Flags default false, including languageRouting. Capture
 * and compatibility writers deliberately have no optional flag here.
 */
function createEngineFeatures(serverConfig = {}, { queuePolicy = 'legacy' } = {}) {
  if (!['legacy', 'fair-queue-v1'].includes(queuePolicy)) throw new TypeError('Invalid fleet queue policy');
  if (!isObject(serverConfig)) throw new TypeError('Invalid engine feature config');
  const allowed = ['version', 'cohortSalt', 'internalUids', 'rolloutPercent', 'flags', 'admission'];
  if (Object.keys(serverConfig).some(key => !allowed.includes(key))) throw new TypeError('Unknown engine config field');
  const {
    version = 'default-off', cohortSalt = 'mapd-cohort-v1', internalUids = [],
    rolloutPercent = 0, flags = {}, admission = {},
  } = serverConfig;
  if (!validVersion(version) || !validVersion(cohortSalt)
      || !Array.isArray(internalUids) || !internalUids.every(validUid)
      || ![0, 5, 25, 100].includes(rolloutPercent)
      || !isObject(flags) || Object.entries(flags).some(([key, value]) => !COHORT_FEATURES.includes(key) || typeof value !== 'boolean')
      || !isObject(admission) || Object.entries(admission).some(([key, value]) => key !== 'stopNewJobs' || typeof value !== 'boolean')) {
    throw new TypeError('Invalid engine feature config');
  }
  // Copy config values; an operator refresh creates a new controller.
  const internal = new Set(internalUids);
  const enabled = Object.fromEntries(FEATURES.map(key => [key, flags[key] === true]));
  const admissionControl = Object.freeze({ stopNewJobs: admission.stopNewJobs === true });

  function selectForVerifiedUid(verifiedUid) {
    if (!validUid(verifiedUid)) throw new TypeError('A verified UID is required');
    const bucket = createHash('sha256').update(JSON.stringify([cohortSalt, verifiedUid])).digest().readUInt32BE(0) % 10000;
    const cohort = internal.has(verifiedUid) ? 'internal' : bucket < rolloutPercent * 100 ? 'rollout' : 'control';
    return freezeSnapshot({
      schemaVersion: SCHEMA_VERSION,
      configVersion: version,
      cohort,
      versions: Object.fromEntries(FEATURES.map(key => [key, key === 'queuePolicy' ? queuePolicy
        : key === 'selectionContract' ? FEATURE_VERSIONS.selectionContract
          : cohort !== 'control' && enabled[key] ? FEATURE_VERSIONS[key] : 'legacy'])),
    });
  }

  /**
   * Pass a UID from verified auth (or the validated stored owner on the admin
   * trigger path), never a submitted userId. recordedSnapshot must come ONLY
   * from a server-owned field on the same user's admitted job. Persist the
   * first result atomically with admission and prohibit client writes to it.
   * A worker calls forExecution; it must not select again at execution.
   * Invalid/unsupported recorded versions throw instead of changing an attempt.
   * JS freezing is defensive only: DB immutability requires rules + transaction.
   */
  function forJob(verifiedUid, recordedSnapshot) {
    if (!validUid(verifiedUid)) throw new TypeError('A verified UID is required');
    if (recordedSnapshot === undefined) return selectForVerifiedUid(verifiedUid);
    if (!isObject(recordedSnapshot) || recordedSnapshot.schemaVersion !== SCHEMA_VERSION
        || !validVersion(recordedSnapshot.configVersion)
        || !['internal', 'rollout', 'control'].includes(recordedSnapshot.cohort)
        || !isObject(recordedSnapshot.versions)
        || Object.keys(recordedSnapshot).some(key => !['schemaVersion', 'configVersion', 'cohort', 'versions'].includes(key))
        || Object.keys(recordedSnapshot.versions).length !== FEATURES.length
        || FEATURES.some(key => !['legacy', FEATURE_VERSIONS[key]].includes(recordedSnapshot.versions[key]))) {
      throw new TypeError('Invalid or unsupported recorded engine features');
    }
    return freezeSnapshot({ ...recordedSnapshot, versions: { ...recordedSnapshot.versions } });
  }

  // Jobs admitted before this contract stay compatible even during a 100%
  // rollout. The worker passes only a server-recorded field, never a client
  // receipt's claimed feature snapshot. No rollout config is consulted.
  function forExecution(recordedSnapshot) {
    if (recordedSnapshot === undefined) {
      return freezeSnapshot({
        schemaVersion: SCHEMA_VERSION, configVersion: 'legacy-unrecorded', cohort: 'control',
        versions: Object.fromEntries(FEATURES.map(key => [key, 'legacy'])),
      });
    }
    return forJob('server-recorded-job', recordedSnapshot);
  }

  // Check this ONLY before admitting NEW work, after existing/terminal job
  // handling. Never gate committed saves, capture, or terminal-state reads.
  // This live emergency control is intentionally absent from job snapshots.
  return Object.freeze({ admission: admissionControl, queuePolicy, selectForVerifiedUid, forJob, forExecution });
}

const forExecution = createEngineFeatures().forExecution;
module.exports = { createEngineFeatures, forExecution, FEATURE_VERSIONS, SCHEMA_VERSION };
