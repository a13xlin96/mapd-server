const crypto = require('crypto');
const { admin } = require('./firestore');

// Authenticate requests. Two paths:
//   1. User path: Bearer Firebase ID token (clients). Server verifies the
//      token and trusts decoded.uid; the userId in the request body must
//      match (enforced downstream).
//   2. Admin path: X-Admin-Token header containing the ENRICH_ADMIN_TOKEN
//      env var. Used by the Firebase Cloud Function that triggers on
//      `enrichmentJobs/{jobId}` doc-creates. Identity is sourced from
//      req.body.userId — this middleware itself does not verify that
//      identity beyond the shared-secret check. index.js's /enrich handler
//      additionally requires a pre-existing job doc with a matching
//      userId+url (see claimEnrichmentJob), which shrinks impersonation
//      blast-radius on that specific route if the admin token ever leaks.
//      That constraint is a property of the /enrich handler, NOT of this
//      middleware: on any other route mounted behind authenticateRequest,
//      an admin-token holder can act as an arbitrary userId with no further
//      check. This is an accepted superset risk from sharing the middleware
//      across routes — keep it in mind before reusing this on a new route.
async function authenticateRequest(req, res, next) {
  const adminTokenHeader = req.headers['x-admin-token'];
  if (typeof adminTokenHeader === 'string' && adminTokenHeader.length > 0) {
    const expected = process.env.ENRICH_ADMIN_TOKEN;
    if (!expected) {
      // Fail closed: never accept the admin header unless the env var is set.
      return res.status(503).json({ error: 'admin path not configured' });
    }
    const provided = Buffer.from(adminTokenHeader);
    const reference = Buffer.from(expected);
    if (provided.length !== reference.length ||
        !crypto.timingSafeEqual(provided, reference)) {
      return res.status(401).json({ error: 'invalid admin token' });
    }
    const bodyUserId = req.body && typeof req.body.userId === 'string' ? req.body.userId : null;
    if (!bodyUserId) {
      return res.status(400).json({ error: 'userId required on admin path' });
    }
    req.authUid = bodyUserId;
    req.adminBypass = true;
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.authUid = decoded.uid;
    req.adminBypass = false;
    return next();
  } catch (err) {
    console.warn('Auth verify failed:', err.message);
    return res.status(401).json({ error: 'Invalid ID token' });
  }
}

module.exports = { authenticateRequest };
