const { firestore, admin } = require('./firestore');
const { sendPushForJob } = require('./push');

// An enrichment job that hasn't moved off 'processing' after this window is
// considered orphaned (server crashed mid-work, yt-dlp hung, etc.). Marking it
// failed releases the client's listener and fires a failure push.
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

async function sweep() {
  if (!firestore) return;
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - STALE_AFTER_MS);
    const snap = await firestore
      .collection('enrichmentJobs')
      .where('status', '==', 'processing')
      .where('createdAt', '<', cutoff)
      .get();

    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      const { userId } = docSnap.data() || {};
      try {
        await docSnap.ref.update({
          status: 'failed',
          failureReason: 'timeout',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
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
