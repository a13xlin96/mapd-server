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

// F59: ensure /configs/featureFlags exists with a boolean
// freezeListMembershipWrites field before any user-facing route can
// observe a missing-doc state. lib/listMembership.js fails closed
// with a 409 when the doc/field is absent (Codex round-6 F19 — a
// deliberate security property: prevents an attacker who can delete
// the doc from silently un-freezing a migration). The strict check
// stays; this seed makes the missing-doc state unreachable on real
// deploys.
//
// Concurrency-safe via Firestore transaction (round-3): two
// instances booting simultaneously, or an admin script racing the
// seed, can't clobber each other's writes — the transaction's
// optimistic concurrency control aborts and retries on conflict.
//
// Idempotent + conservative:
//   - Doc missing → create with { freezeListMembershipWrites: false }.
//   - Doc exists, field genuinely absent → update with `false`.
//   - Doc exists, field is non-boolean → DO NOT overwrite. Preserves
//     the route's fail-closed posture for malformed state. An admin
//     who wrote a corrupted value must take explicit corrective
//     action; the seed never silently coerces malformed → false
//     (which would un-freeze a migration on restart).
//   - Doc exists, field is a boolean → no-op.
async function seedFeatureFlags(fs) {
  if (!fs) return { action: 'skipped', reason: 'no-firestore' };
  const ref = fs.collection('configs').doc('featureFlags');
  return fs.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      txn.set(ref, { freezeListMembershipWrites: false });
      return { action: 'created' };
    }
    const data = snap.data() || {};
    const has = Object.prototype.hasOwnProperty.call(data, 'freezeListMembershipWrites');
    if (!has) {
      txn.update(ref, { freezeListMembershipWrites: false });
      return { action: 'field-added' };
    }
    if (typeof data.freezeListMembershipWrites !== 'boolean') {
      return { action: 'malformed-left-intact', value: data.freezeListMembershipWrites };
    }
    return { action: 'already-present', value: data.freezeListMembershipWrites };
  });
}

// Exposed as a promise the server's bootstrap can `await` before
// listen()-ing. F59 round-2: without awaiting, the seed races
// incoming requests at process start and the missing-doc 409 is
// still reachable in the first few hundred ms.
const seedFeatureFlagsPromise = firestore
  ? seedFeatureFlags(firestore)
      .then((result) => {
        const valueSuffix = result.value !== undefined ? ` (existing value: ${result.value})` : '';
        console.log(`featureFlags seed: ${result.action}${valueSuffix}`);
        return result;
      })
      .catch((err) => {
        // Degrade gracefully: existing 409 trip-wire in the routes is
        // no worse than today. Don't crash the server.
        console.warn('featureFlags seed failed (non-fatal):', err.message);
        return { action: 'failed', reason: err.message };
      })
  : Promise.resolve({ action: 'skipped', reason: 'no-firestore' });

module.exports = { admin, firestore, seedFeatureFlags, seedFeatureFlagsPromise };
