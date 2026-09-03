// S5 interest-profile-server-side plan, Task 1+2: authoritative writes to
// users/{uid}/interestProfile/latest — the monetization-critical
// save-behavior signal. This used to be written client-side (see the
// stale TODO at mapd's interestProfile.ts:5), which meant totalPins and
// the last-pin-category/city/country breadcrumbs were fully tamperable by
// anyone who could reach their own Firestore SDK. The uid here comes
// exclusively from the verified ID token (authenticateRequest sets
// req.authUid) — never from the request body — so a client can no longer
// inflate its own signal or attribute pins to another uid.
//
// Two writers share the same merge-set:
//   - POST /interest-profile/pin-saved (this file's router): the client's
//     fire-and-forget call after a pin save, replacing the direct
//     Firestore write.
//   - recordPinSaved (exported helper): called from enrich.js after a
//     successful NEW-pin transactional write on the cloud-function path,
//     where no client-side call ever ran (see enrich.js for the trace).
const express = require('express');
const { firestore, admin } = require('./firestore');
const { authenticateRequest } = require('./auth');

const router = express.Router();

// Mirrors listMembership.js's requireFirestore (not exported from that
// file, so replicated here per its own comment on that pattern).
function requireFirestore(req, res, next) {
  if (!firestore) {
    return res.status(503).json({ error: 'Firestore admin not configured' });
  }
  return next();
}

// Bound + coerce an optional display field. Empty/non-string input becomes
// null rather than an empty string, matching Firestore's existing shape for
// "we don't know the city/country" (client wrote null for these too).
function cleanStr(v) {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 128) : null;
}

async function writeProfile(uid, { category, city, country }) {
  const ref = firestore
    .collection('users').doc(uid)
    .collection('interestProfile').doc('latest');
  await ref.set({
    totalPins: admin.firestore.FieldValue.increment(1),
    lastPinCategory: category,
    lastPinCity: cleanStr(city),
    lastPinCountry: cleanStr(country),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

router.post(
  '/interest-profile/pin-saved',
  authenticateRequest,
  requireFirestore,
  async (req, res) => {
    const { category, city, country } = req.body || {};
    if (typeof category !== 'string' || category.length === 0 || category.length > 64) {
      return res.status(400).json({ error: 'invalid_category' });
    }
    // uid comes from the verified token, NEVER from req.body — a body
    // {userId: 'someone-else'} on the Bearer path is simply ignored, since
    // req.authUid is set by authenticateRequest before this handler runs.
    const uid = req.authUid;
    try {
      await writeProfile(uid, { category, city, country });
      return res.json({ ok: true });
    } catch (err) {
      console.error(`recordPinSaved(${uid}) failed:`, err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// Shared helper for server-saved pins (Task 2 — enrich.js's runEnrichment,
// after writePinTransactional confirms a NEW pin). Looser validation than
// the route above: this runs fire-and-forget right after a real pin write
// succeeded, so it must never throw or block the response on odd category
// data — it defaults to 'other' instead of rejecting.
async function recordPinSaved(uid, { category, city, country } = {}) {
  const safeCategory = typeof category === 'string' && category.length > 0
    ? category.slice(0, 64)
    : 'other';
  return writeProfile(uid, { category: safeCategory, city, country });
}

module.exports = { interestProfileRouter: router, recordPinSaved };
