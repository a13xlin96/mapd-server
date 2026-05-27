// Atomic claim transition for /enrich. Wraps the Firestore transaction that
// transitions a job from pending/missing → processing exactly once even under
// concurrent callers (in-app POST + Cloud Function trigger during rollout,
// or Firebase auto-retry collisions of the same Function invocation).
//
// Returns { code, body, shouldEnrich, enrichArgs }. Caller is responsible for
// HTTP response and (if shouldEnrich) firing runEnrichment using enrichArgs
// (NOT the original request body — see field-takeover note below).
//
// Security properties:
//   1. Pre-existing-doc claim requires stored userId === request userId AND
//      stored url === request url. Prevents Bearer cross-user attack: user B
//      with their own valid token + knowledge of user A's jobId cannot force
//      a claim on A's pending doc (Codex P1 fix).
//   2. Admin bypass additionally requires the doc to pre-exist (it cannot
//      create from scratch). Shrinks impersonation blast-radius if
//      ENRICH_ADMIN_TOKEN leaks: attacker can only re-trigger jobs the
//      legitimate user already created.
//   3. enrichArgs returns the STORED url + captionText when a pending doc
//      pre-existed, not the request body. Prevents body-supplied
//      captionText / url from changing the AI-extraction pipeline's input
//      for a job whose content was already fixed at write-time (Codex P2 fix).

const { admin } = require('./firestore');

function firestoreTs() {
  return admin.firestore.FieldValue.serverTimestamp();
}

async function claimEnrichmentJob(firestore, { jobId, userId, url, captionText, adminBypass }) {
  const jobRef = firestore.collection('enrichmentJobs').doc(jobId);

  return firestore.runTransaction(async (txn) => {
    const snap = await txn.get(jobRef);

    if (snap.exists) {
      const existing = snap.data();

      // Field-match check applies to BOTH admin and Bearer paths.
      // Bearer-path scenario: user A wrote a pending doc; user B (their own
      // valid Bearer token) POSTs with A's jobId + B's userId/url. Without
      // this check we'd transition A's doc to 'processing' and run
      // enrichment for B's content under A's listener — wrong-data
      // injection. With the check, B is 403'd.
      if (existing.userId !== userId || existing.url !== url) {
        const msg = adminBypass
          ? 'admin bypass: body does not match stored doc'
          : 'request does not match stored doc';
        return { code: 403, body: { error: msg }, shouldEnrich: false };
      }

      if (existing.status === 'processing') {
        return { code: 202, body: { jobId, status: 'processing' }, shouldEnrich: false };
      }
      if (existing.status && existing.status !== 'pending') {
        // Terminal status (complete, duplicate, failed, needs_selection) — return as-is.
        return { code: 200, body: { jobId, status: existing.status }, shouldEnrich: false };
      }

      // status === 'pending' or status missing — claim it. Use txn.update so
      // we touch ONLY mutable fields; client-set userId/url/captionText/
      // createdAt are preserved by omission.
      txn.update(jobRef, {
        status: 'processing',
        attempts: 0,
        triggeredBy: adminBypass ? 'cloud_function' : 'direct_post',
        updatedAt: firestoreTs(),
      });

      // CRITICAL: pass STORED url/captionText to enrichment, NOT request body.
      // The request body was already validated to match stored userId+url
      // above, so for url they're identical. For captionText we MUST use
      // stored because the request body is untrusted (admin path: attacker
      // with leaked token could substitute; Bearer path: client bug could
      // diverge). Stored captionText is what the user actually wrote at
      // share-time via the rules-gated client write.
      return {
        code: 202,
        body: { jobId, status: 'processing' },
        shouldEnrich: true,
        enrichArgs: {
          url: existing.url,
          userId: existing.userId,
          captionText: existing.captionText || '',
        },
      };
    }

    // Doc didn't exist — legacy direct-POST path only (Bearer auth).
    if (adminBypass) {
      return {
        code: 403,
        body: { error: 'admin bypass requires pre-existing pending doc' },
        shouldEnrich: false,
      };
    }

    txn.set(jobRef, {
      userId,
      url,
      captionText: captionText || '',
      status: 'processing',
      triggeredBy: 'direct_post',
      attempts: 0,
      createdAt: firestoreTs(),
      updatedAt: firestoreTs(),
    });
    return {
      code: 202,
      body: { jobId, status: 'processing' },
      shouldEnrich: true,
      enrichArgs: { url, userId, captionText: captionText || '' },
    };
  });
}

module.exports = { claimEnrichmentJob };
