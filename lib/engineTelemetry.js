const metrics = require('./engineMetrics');
const jobContext = require('./jobContext');
const VERSION = require('./engineVersion');

const stage = (name, work) => metrics.current()?.stage(name, work) || work();
function prices() {
  if (!process.env.ENGINE_PRICE_TABLE_JSON) return { prices: metrics.DEFAULT_PRICES, priceConfiguration: 'default' };
  try { return { prices: metrics.validatePrices(JSON.parse(process.env.ENGINE_PRICE_TABLE_JSON)), priceConfiguration: 'configured' }; }
  // Pricing is optional observation, never a reason to discard a save or stop
  // execution. Preserve usage; expose unavailable cost instead of inventing it.
  catch { return { prices: metrics.DEFAULT_PRICES, priceConfiguration: 'invalid' }; }
}
function start(platform, queueMs) {
  return metrics.start({ platform, language: 'unknown', featureVersion: VERSION.engine,
    featureVersions: [VERSION.engine], ...prices(), queueMs });
}

function outcomeOf(data) {
  if (data?.status === 'needs_selection') return 'confirmation';
  if (data?.status === 'complete') return 'success';
  if (data?.status === 'duplicate') return 'duplicate';
  if (data?.status !== 'failed') return 'unknown';
  if (data.failure?.code === 'partial_save' || data.progress?.saved > 0) return 'partial';
  return ({ access_blocked: 'blocked', rate_limited: 'rate_limited',
    dependency_timeout: 'timeout', attempt_stopped: 'cancelled',
    no_place_found: 'no_place', no_verified_match: 'no_place' }[data.failure?.code] || 'failed');
}

async function persist(db) {
  const context = jobContext.current();
  if (!db || !context || !metrics.current()) return;
  // Read final state to distinguish confirmation and partial saves from a
  // successful function return. The pipeline handles most failures internally.
  const ref = db.collection('enrichmentJobs').doc(context.jobId);
  const snapshot = await ref.get(), data = snapshot.data();
  if (!['complete', 'duplicate', 'needs_selection', 'failed'].includes(data?.status)) return;
  const outcome = outcomeOf(data);
  return metrics.persistPrivate(async ({ jobId, leaseOwner, report }) => {
    await db.runTransaction(async txn => {
      const current = (await txn.get(ref)).data();
      if (!current || current.userId !== context.userId || (leaseOwner && current.workerOwner !== leaseOwner)) return;
      const reportRef = db.collection('engineMetrics').doc(jobId);
      if ((await txn.get(reportRef)).exists) return;
      txn.set(reportRef, { ...report,
        engineVersion: VERSION, features: current.engineFeatures || null,
        workerQueuePolicy: current.workerQueuePolicy || null });
    });
  }, outcome);
}
// Call inside the terminal-state transaction, after other reads and before
// job writes. A job ID represents one attempt; terminal replay cannot overwrite
// its report. Atomic persistence means a metrics outage cannot lose the report
// while committing the failure. No provider work or separate retry is involved.
async function recordTerminal(txn, db, ref, data, { now = Date.now(), reason = 'queue_expired', processingMissingReason = 'not_started' } = {}) {
  const reportRef = db.collection('engineMetrics').doc(ref.id);
  if ((await txn.get(reportRef)).exists) return;
  const admitted = data.admittedAt?.toMillis?.();
  const queueEnd = processingMissingReason === 'not_started' ? now : data.processingStartedAt?.toMillis?.();
  const report = metrics.createMetrics({ platform: 'unknown', language: 'unknown',
    featureVersion: VERSION.engine, featureVersions: [VERSION.engine], ...prices(),
    queueMs: Number.isFinite(admitted) && Number.isFinite(queueEnd) ? Math.max(0, queueEnd - admitted) : null,
    processingMissingReason, wallNow: () => new Date(now),
  }).finish(outcomeOf(data));
  txn.set(reportRef, { ...report, terminalReason: reason,
    engineVersion: VERSION, features: data.engineFeatures || null,
    workerQueuePolicy: data.workerQueuePolicy || null });
}

// Fenced fallback for an exception escaping the execution wrapper. Never
// overwrite committed/partial results; time was not observed by this reporter.
async function failAttempt(db, jobId, userId, options, error, processingMissingReason = 'not_observed') {
  const { failureOf } = require('./engineError');
  const { admin } = require('./firestore');
  const ref = db.collection('enrichmentJobs').doc(jobId);
  return db.runTransaction(async txn => {
    const data = (await txn.get(ref)).data();
    if (!data || data.userId !== userId || data.status !== 'processing'
        || (data.workerOwner || null) !== (options.leaseOwner || null)) return false;
    const failure = failureOf(error, { stage: 'configuration' });
    await recordTerminal(txn, db, ref, { ...data, status: 'failed', failure },
      { reason: failure.stage === 'configuration' ? 'invalid_execution_configuration' : 'execution_interrupted', processingMissingReason });
    txn.update(ref, { status: 'failed', engineQueued: false, failure,
      completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}
module.exports = { stage, start, persist, outcomeOf, recordTerminal, failAttempt };
