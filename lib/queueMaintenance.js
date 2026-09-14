const { EngineError, failureOf } = require('./engineError');
const { QUEUE_MS, releaseAdmission } = require('./enrichAdmission');
const { recordTerminal } = require('./engineTelemetry');
const millis = value => typeof value?.toMillis === 'function' ? value.toMillis() : NaN;

function createQueueMaintenance({ db, admin, push = async () => {}, pageSize = 100, now = Date.now }) {
  let cursor = null, running = false;
  async function expire(ref) {
    const result = await db.runTransaction(async txn => {
      const snap = await txn.get(ref), data = snap.data();
      if (!data || data.status !== 'pending' || data.engineQueued !== true) return null;
      const deadline = millis(data.queueDeadline);
      if (Number.isFinite(deadline) && deadline > now()) return null;
      const failure = failureOf(new EngineError('dependency_timeout', { stage: 'admission' }));
      await recordTerminal(txn, db, ref, { ...data, status: 'failed', failure }, { now: now() });
      txn.update(ref, { status: 'failed', engineQueued: false, failure,
        completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return data;
    });
    if (result?.userId) {
      await releaseAdmission(db, result.userId, ref.id);
      await push(ref.id, result.userId, 'failed');
    }
    return !!result;
  }
  async function sweep() {
    if (!db || running) return;
    running = true;
    try {
      const expired = await db.collection('enrichmentJobs').where('status', '==', 'pending')
        .where('engineQueued', '==', true).where('queueDeadline', '<=', admin.firestore.Timestamp.fromMillis(now()))
        .orderBy('queueDeadline').limit(pageSize).get();
      for (const doc of expired.docs) await expire(doc.ref);
      // Bounded cursor scan handles documents absent from the ordered query
      // (missing fields) and terminal queue flags left by an interrupted worker.
      let query = db.collection('enrichmentJobs').where('engineQueued', '==', true).orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        let terminalUser = null;
        await db.runTransaction(async txn => {
          const data = (await txn.get(doc.ref)).data();
          if (!data?.engineQueued) return;
          if (data.status !== 'pending') {
            // A processing job already owns admission; don't release its quota.
            if (data.status !== 'processing') terminalUser = data.userId;
            txn.update(doc.ref, { engineQueued: false });
          } else if (!Number.isFinite(millis(data.queueDeadline))) {
            const admitted = millis(data.admittedAt);
            if (Number.isFinite(admitted)) txn.update(doc.ref, { queueDeadline: admin.firestore.Timestamp.fromMillis(admitted + QUEUE_MS) });
          }
        });
        if (terminalUser) await releaseAdmission(db, terminalUser, doc.id);
        await expire(doc.ref);
      }
      cursor = page.docs.length === pageSize ? page.docs[page.docs.length - 1] : null;
    } finally { running = false; }
  }
  return { sweep };
}
module.exports = { createQueueMaintenance };
