const admin = require('firebase-admin');

let firestore = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const json = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestore = admin.firestore();
    console.log('Firestore admin initialized');
  } else {
    console.log('FIREBASE_SERVICE_ACCOUNT_JSON not set — /enrich endpoint will be disabled');
  }
} catch (err) {
  console.warn('Firestore init failed:', err.message);
  firestore = null;
}

module.exports = { admin, firestore };
