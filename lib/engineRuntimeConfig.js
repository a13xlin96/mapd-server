const { createEngineFeatures, forExecution } = require('./engineFeatures');
const { EngineError } = require('./engineError');

let previous, previousPolicy, controller;
function getEngineFeatures() {
  const raw = process.env.ENGINE_ROLLOUT_JSON || '{}', policy = queuePolicy();
  if (raw !== previous || policy !== previousPolicy) {
    // Never echo config: internal account IDs are private.
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid ENGINE_ROLLOUT_JSON'); }
    controller = createEngineFeatures(parsed, { queuePolicy: policy });
    previous = raw; previousPolicy = policy;
  }
  return controller;
}

function queuePolicy() {
  const value = process.env.ENGINE_QUEUE_POLICY || 'legacy';
  if (!['legacy', 'fair-queue-v1'].includes(value)) throw new Error('Invalid ENGINE_QUEUE_POLICY');
  return value;
}

// FLEET ROLLOUT CONTRACT (server-only engineControl/queueRollout):
// {schemaVersion: 1, policy: 'legacy' | 'fair-queue-v1'}.
// Missing contract permits legacy only. Every admitting process and worker must
// check the contract transactionally; a mixed policy fleet fails closed. Fairness
// applies only to a homogeneous fleet with all claimers enforcing this protocol.
// Before first enabling fair: deploy this protocol to ALL legacy claimers, stop
// new admission, drain pending AND processing work, stop old workers, ensure the
// fair queue index exists, then change the contract and every process's
// ENGINE_QUEUE_POLICY together. Resume admission only with matching processes.
// Rollback uses the SAME drain/stop sequence. Never rewrite queued snapshots or
// flip policy on active work. Old binaries cannot enforce this fence and MUST
// be stopped before enabling fair; this document alone cannot fence old code.
async function assertQueueFleet(txn, db, policy) {
  if (!['legacy', 'fair-queue-v1'].includes(policy)) throw new EngineError('dependency_error', { stage: 'queue_policy' });
  const contract = (await txn.get(db.collection('engineControl').doc('queueRollout'))).data();
  if ((!contract && policy === 'legacy') || (contract?.schemaVersion === 1 && contract.policy === policy)) return;
  throw new EngineError('dependency_error', { stage: 'queue_policy' });
}

// Recorded execution is deliberately independent of ALL live rollout parsing.
function executionFeatures(snapshot) {
  try { return forExecution(snapshot); }
  catch (cause) { throw new EngineError('dependency_error', { stage: 'configuration', cause }); }
}

module.exports = { getEngineFeatures, queuePolicy, assertQueueFleet, executionFeatures };
