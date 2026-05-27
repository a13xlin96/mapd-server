// Firebase Cloud Function: triggers on enrichmentJobs/{jobId} creates where
// the client wrote status:'pending'. POSTs /enrich on the user's behalf via
// admin-header bypass, with patient retry — unlike the phone's JS runtime,
// this function is not iOS-suspended when the user backgrounds Mapd.
//
// See plan: ~/.claude/plans/run-codex-adversarial-review-on-every-refactored-nest.md

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) admin.initializeApp();

const ENRICH_ADMIN_TOKEN = defineSecret('ENRICH_ADMIN_TOKEN');
const ENRICH_SERVER_URL =
  process.env.ENRICH_SERVER_URL || 'https://mapd-server.onrender.com';
const MAX_AGE_MS = 30 * 60 * 1000;

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// Pure(ish) handler factory — dependencies injected so unit tests can stub
// firestore + axios + secret without booting the Functions runtime.
//
// Key safety properties:
//  - Status filter (data.status === 'pending') skips legacy direct-POST docs
//    (server creates those with status:'processing'), so we never double-
//    trigger enrichment for old client versions still in the wild.
//  - Age cap (MAX_AGE_MS): jobs older than 30 min are marked failed without
//    further retry. Beyond that, the user has moved on.
//  - All "mark failed" writes go through markFailedIfStillPending, a
//    transactional CAS that only writes 'failed' if the doc's current status
//    is still 'pending'. Prevents clobbering state that a concurrent actor
//    (legacy direct-POST claim, sweeper) may have advanced.
//  - 4xx from /enrich is terminal (mark failed, return null); 5xx and
//    network errors throw to trigger Firebase exponential backoff.
//  - /enrich is fire-and-forget: it returns 202 immediately after the
//    transactional claim (~100ms warm), then runs runEnrichment async.
//    So the 90s HTTP timeout only covers TCP+TLS+claim, not enrichment.
//    A cold Render dyno takes 30-60s to start serving; 90s is generous.
function createEnrichOnPendingJobHandler({
  firestore,
  axiosInstance,
  getAdminToken,
  enrichServerUrl,
  serverTimestamp,
  maxAgeMs = MAX_AGE_MS,
  log = console,
}) {
  async function markFailedIfStillPending(jobRef, error) {
    await firestore.runTransaction(async (txn) => {
      const fresh = await txn.get(jobRef);
      if (!fresh.exists) return;
      if (fresh.data().status !== 'pending') return; // someone else advanced it
      txn.update(jobRef, {
        status: 'failed',
        error,
        updatedAt: serverTimestamp(),
      });
    });
  }

  return async function handler(event) {
    const snap = event.data;
    if (!snap) return null;
    const data = snap.data();
    const jobId = event.params.jobId;

    if (data.status !== 'pending') {
      log.log(`[enrichFn] skip job=${jobId} status=${data.status}`);
      return null;
    }

    if (!data.url || !data.userId) {
      log.warn(`[enrichFn] malformed pending doc job=${jobId}`);
      await markFailedIfStillPending(snap.ref, 'malformed_pending_doc');
      return null;
    }

    const eventTimeMs = event.time ? new Date(event.time).getTime() : NaN;
    if (Number.isFinite(eventTimeMs) && Date.now() - eventTimeMs > maxAgeMs) {
      log.warn(`[enrichFn] retry cap exceeded job=${jobId}`);
      await markFailedIfStillPending(snap.ref, 'cloud_function_max_retry_exceeded');
      return null;
    }

    log.log(`[enrichFn] dispatching job=${jobId} url=${data.url}`);

    let resp;
    try {
      resp = await axiosInstance.post(
        `${enrichServerUrl}/enrich`,
        {
          jobId,
          url: data.url,
          userId: data.userId,
          captionText: data.captionText || '',
        },
        {
          headers: { 'X-Admin-Token': getAdminToken() },
          timeout: 90_000,
          validateStatus: () => true,
        },
      );
    } catch (err) {
      // Network errors (DNS, connection refused, socket reset) → throw to
      // let Firebase retry with exponential backoff. /enrich's transactional
      // claim is idempotent so re-dispatch is safe.
      log.error(`[enrichFn] network error job=${jobId}: ${err.message}`);
      throw err;
    }

    if (resp.status === 200 || resp.status === 202) {
      log.log(`[enrichFn] ok job=${jobId} status=${resp.status}`);
      return null;
    }

    if (resp.status >= 400 && resp.status < 500) {
      log.warn(`[enrichFn] 4xx job=${jobId} status=${resp.status} body=${JSON.stringify(resp.data)}`);
      await markFailedIfStillPending(snap.ref, `enrich_http_${resp.status}`);
      return null;
    }

    log.error(`[enrichFn] 5xx job=${jobId} status=${resp.status}`);
    throw new Error(`/enrich returned ${resp.status}`);
  };
}

// Production handler — wires the injected deps to real firebase-admin + axios.
const productionHandler = createEnrichOnPendingJobHandler({
  firestore: admin.firestore(),
  axiosInstance: axios,
  getAdminToken: () => ENRICH_ADMIN_TOKEN.value(),
  enrichServerUrl: ENRICH_SERVER_URL,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});

exports.enrichOnPendingJob = onDocumentCreated(
  {
    document: 'enrichmentJobs/{jobId}',
    secrets: [ENRICH_ADMIN_TOKEN],
    timeoutSeconds: 540,
    memory: '256MiB',
    retry: true,
  },
  productionHandler,
);

// Test surface.
exports._internal = { createEnrichOnPendingJobHandler };
