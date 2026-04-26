const { Expo } = require('expo-server-sdk');
const { firestore } = require('./firestore');

const expo = new Expo();

// Raw send. Validates the token and swallows errors so a push failure
// never breaks the enrichment pipeline.
async function sendPush(to, title, body, data) {
  if (!to || !Expo.isExpoPushToken(to)) {
    if (to) console.warn('Invalid Expo push token:', to);
    return;
  }
  try {
    // priority + channelId are Android-only routing hints. Without
    // priority: 'high' Android may batch the push and skip the heads-up
    // banner; without channelId Expo doesn't know which channel's
    // importance/vibration to use. iOS ignores both fields.
    await expo.sendPushNotificationsAsync([{
      to,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'default_v2',
    }]);
  } catch (err) {
    console.error('Expo push send failed:', err);
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
    if (!token) return;

    const { placeName, pinId } = extra;
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
        body = placeName ? `${placeName} — already saved` : 'This place is already saved';
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
    await sendPush(token, title, body, data);
  } catch (err) {
    console.error('sendPushForJob failed:', err);
  }
}

module.exports = { sendPush, sendPushForJob };
