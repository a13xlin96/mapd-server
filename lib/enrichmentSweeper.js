const { firestore, admin } = require('./firestore');
const { sendPushForJob } = require('./push');

// Heartbeat staleness: runEnrichment fires updateJob every 30s. Missing
// roughly 4 heartbeats means the worker is stuck, dead, or never started.
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
// Absolute deadline: catches jobs whose heartbeat keeps firing but never
// reaches a terminal state (e.g. infinite loop with the interval still ticking).
const ABSOLUTE_DEADLINE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

async function sweep() {
  if (!firestore) return;
  try {
    const now = Date.now();
    const heartbeatCutoff = admin.firestore.Timestamp.fromMillis(now - HEARTBEAT_STALE_MS);
    const deadlineCutoff = admin.firestore.Timestamp.fromMillis(now - ABSOLUTE_DEADLINE_MS);

    // Two queries: one on stale heartbeat, one on absolute age. Firestore
    // only allows range filters on a single field per query, so we union
    // and dedupe client-side.
    const [byHeartbeat, byDeadline] = await Promise.all([
      firestore
        .collection('enrichmentJobs')
        .where('status', '==', 'processing')
        .where('updatedAt', '<', heartbeatCutoff)
        .get(),
      firestore
        .collection('enrichmentJobs')
        .where('status', '==', 'processing')
        .where('createdAt', '<', deadlineCutoff)
        .get(),
    ]);

    const docs = new Map();
    for (const d of byHeartbeat.docs) docs.set(d.id, d);
    for (const d of byDeadline.docs) docs.set(d.id, d);
    if (docs.size === 0) return;

    for (const docSnap of docs.values()) {
      const { userId } = docSnap.data() || {};
      try {
        // Terminal-state guard: re-read inside a transaction so we never
        // overwrite a complete/duplicate/needs_selection that a live worker
        // wrote between the query snapshot and this update.
        const marked = await firestore.runTransaction(async (txn) => {
          const fresh = await txn.get(docSnap.ref);
          if (!fresh.exists) return false;
          if ((fresh.data() || {}).status !== 'processing') return false;
          txn.set(docSnap.ref, {
            status: 'failed',
            failureReason: 'timeout',
            failureSource: 'sweeper',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          return true;
        });

        if (!marked) {
          console.log(`Sweep skipped ${docSnap.id} — already terminal`);
          continue;
        }

        if (userId) {
          await sendPushForJob(docSnap.id, userId, 'failed').catch((err) => {
            console.warn(`Sweep push for ${docSnap.id} failed:`, err.message || err);
          });
        }
        console.log(`Swept orphaned enrichment job ${docSnap.id} (user ${userId || '?'})`);
      } catch (err) {
        console.error(`Sweep update for ${docSnap.id} failed:`, err.message || err);
      }
    }
  } catch (err) {
    console.error('enrichmentSweeper.sweep failed:', err.message || err);
  }
}

// Run once on startup — catches orphans left behind by a previous process.
sweep().catch((err) => console.error('startup sweep failed:', err));

// Recurring sweep while the process is alive.
const interval = setInterval(sweep, SWEEP_INTERVAL_MS);
// Don't keep the event loop alive for the timer alone — lets the process exit
// cleanly on SIGTERM instead of waiting up to 2 min.
if (typeof interval.unref === 'function') interval.unref();

module.exports = { sweep };
