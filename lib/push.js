const { Expo } = require('expo-server-sdk');
const { firestore, admin } = require('./firestore');

const expo = new Expo();

// Returns { status, error } so sendPushForJob can persist delivery telemetry.
// status: 'sent' | 'no_token' | 'dispatch_failed' | 'ticket_error'.
async function dispatchPush(to, title, body, data) {
  if (!to) return { status: 'no_token', error: null };
  if (!Expo.isExpoPushToken(to)) {
    console.warn('Invalid Expo push token:', to);
    return { status: 'no_token', error: 'Invalid token format' };
  }
  try {
    // priority + channelId are Android-only routing hints. Without
    // priority: 'high' Android may batch the push and skip the heads-up
    // banner; without channelId Expo doesn't know which channel's
    // importance/vibration to use. iOS ignores both fields.
    const tickets = await expo.sendPushNotificationsAsync([{
      to,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'default_v2',
    }]);
    const errored = (tickets || []).find((t) => t && t.status === 'error');
    if (errored) {
      const detail = (errored.details && errored.details.error) || errored.message || 'unknown';
      console.warn('Expo push ticket error:', detail);
      return { status: 'ticket_error', error: String(detail) };
    }
    return { status: 'sent', error: null };
  } catch (err) {
    console.error('Expo push send failed:', err);
    return { status: 'dispatch_failed', error: String((err && err.message) || err) };
  }
}

// Fire-and-forget convenience for callers that don't track delivery.
async function sendPush(to, title, body, data) {
  await dispatchPush(to, title, body, data);
}

// Persists pushDelivery telemetry on the job doc so silent push failures
// (bad token, Expo down, DeviceNotRegistered) become visible in Firestore.
// Read-then-write so we can increment attempts without dotted-path semantics.
async function recordPushDelivery(jobId, { status, error, tokenPresent }) {
  if (!firestore || !jobId) return;
  try {
    const docRef = firestore.collection('enrichmentJobs').doc(jobId);
    const snap = await docRef.get();
    if (!snap.exists) return;
    const prior = (snap.data() || {}).pushDelivery || {};
    const attempts = (typeof prior.attempts === 'number' ? prior.attempts : 0) + 1;
    await docRef.set({
      pushDelivery: {
        status,
        attempts,
        lastError: error || null,
        tokenPresent: Boolean(tokenPresent),
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn(`Failed to record pushDelivery for ${jobId}:`, err.message || err);
  }
}

// Push helper for enrichment job status updates. Looks up the user's
// expoPushToken and sends a type-discriminated payload so the client can
// route based on data.type. Additional notification categories (invites,
// shares, etc.) should live alongside this as sibling helpers rather than
// growing this switch statement.
async function sendPushForJob(jobId, userId, status, extra = {}) {
  if (!firestore) return;
  try {
    const snap = await firestore.collection('users').doc(userId).get();
    const token = snap.exists ? snap.data().expoPushToken : null;
    if (!token) {
      await recordPushDelivery(jobId, { status: 'no_token', error: null, tokenPresent: false });
      return;
    }

    const { placeName, pinId, sourceAdded } = extra;
    let title;
    let body;
    let type;

    switch (status) {
      case 'complete':
        type = 'pin_saved';
        title = '📍 Pin saved!';
        body = placeName ? `${placeName} added to your map` : 'Your link is on the map';
        break;
      case 'duplicate':
        type = 'pin_duplicate';
        title = 'Already on your map';
        // sourceAdded: this share was a NEW video about an already-pinned
        // place and got appended to the pin's sources — tell the user their
        // link was kept, not dropped.
        if (sourceAdded) {
          body = placeName ? `${placeName} — new link added` : 'New link added to a place you saved';
        } else {
          body = placeName ? `${placeName} — already saved` : 'This place is already saved';
        }
        break;
      case 'needs_selection':
        type = 'pin_needs_selection';
        title = 'Multiple places found';
        body = 'Tap to choose which to save';
        break;
      case 'failed':
        type = 'pin_failed';
        title = "Couldn't find a place";
        body = 'Tap to see your failed link';
        break;
      default:
        return;
    }

    const data = { type, jobId };
    if (pinId) data.pinId = pinId;
    const result = await dispatchPush(token, title, body, data);
    await recordPushDelivery(jobId, { ...result, tokenPresent: true });
  } catch (err) {
    console.error('sendPushForJob failed:', err);
  }
}

module.exports = { sendPush, sendPushForJob, dispatchPush, recordPushDelivery };
