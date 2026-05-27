// Tests the transactional claim semantics of claimEnrichmentJob.
// Pure unit tests against the extracted module — no HTTP layer.
//
// Covers:
//   - Doc missing → creates with triggeredBy='direct_post' (Bearer path)
//   - Doc pending → claims via txn.update, preserves client-set fields
//   - Doc processing → idempotent 202, does NOT re-fire enrichment
//   - Doc terminal (complete/duplicate/failed/needs_selection) → 200 returns as-is
//   - Admin bypass without doc → 403
//   - Admin bypass with mismatched userId/url → 403
//   - Admin bypass with matching pending doc → claims with triggeredBy='cloud_function',
//     preserves client-set userId/url/captionText/createdAt by omission

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return {
    firestore: getSharedFirestore(),
    admin: makeAdmin(),
  };
});

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { claimEnrichmentJob } = require('../lib/enrichClaim');

const fs = getSharedFirestore();

const JOB_ID = 'job_txn_test';
const USER_ID = 'u_txn';
const URL = 'https://www.instagram.com/p/xyz/';

beforeEach(() => fs.reset());

describe('claimEnrichmentJob — direct (Bearer) path', () => {
  test('doc missing → creates with full record + shouldEnrich=true', async () => {
    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'hello',
      adminBypass: false,
    });

    expect(result.code).toBe(202);
    expect(result.body).toEqual({ jobId: JOB_ID, status: 'processing' });
    expect(result.shouldEnrich).toBe(true);

    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc).toMatchObject({
      userId: USER_ID,
      url: URL,
      captionText: 'hello',
      status: 'processing',
      triggeredBy: 'direct_post',
      attempts: 0,
    });
    expect(doc.createdAt).toBeDefined();
    expect(doc.updatedAt).toBeDefined();
  });

  test('doc already processing → 202 idempotent, shouldEnrich=false', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'processing', attempts: 0,
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(1500),
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: false,
    });

    expect(result.code).toBe(202);
    expect(result.body).toEqual({ jobId: JOB_ID, status: 'processing' });
    expect(result.shouldEnrich).toBe(false);
  });

  test('doc terminal (complete) → 200 returns existing status, shouldEnrich=false', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'complete', pinId: 'pin_1',
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(2000),
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: false,
    });

    expect(result.code).toBe(200);
    expect(result.body).toEqual({ jobId: JOB_ID, status: 'complete' });
    expect(result.shouldEnrich).toBe(false);
  });

  test('doc terminal (needs_selection) → 200 returns existing status', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'needs_selection',
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: false,
    });

    expect(result.code).toBe(200);
    expect(result.body.status).toBe('needs_selection');
  });

  test('doc pending (legacy or rolled-back state) → claims via update, preserves fields', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID,
      url: URL,
      captionText: 'client-written caption',
      status: 'pending',
      createdAt: FakeTimestamp.fromMillis(1000),
      updatedAt: FakeTimestamp.fromMillis(1000),
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID,
      userId: USER_ID,
      url: URL,
      // Note: caller may pass a DIFFERENT captionText than what's stored.
      // The txn.update path should NOT overwrite the stored captionText.
      captionText: 'ignored on pending claim',
      adminBypass: false,
    });

    expect(result.code).toBe(202);
    expect(result.shouldEnrich).toBe(true);

    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('direct_post');
    expect(doc.captionText).toBe('client-written caption'); // preserved!
    expect(doc.userId).toBe(USER_ID); // preserved
    expect(doc.url).toBe(URL); // preserved
    expect(doc.createdAt.toMillis()).toBe(1000); // preserved — server didn't rewrite
    expect(doc.attempts).toBe(0); // newly set by claim
  });
});

describe('claimEnrichmentJob — admin-bypass path', () => {
  test('no doc → 403 (refuses to create on admin path)', async () => {
    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true,
    });

    expect(result.code).toBe(403);
    expect(result.body.error).toMatch(/pre-existing pending doc/i);
    expect(result.shouldEnrich).toBe(false);
    expect(fs.read('enrichmentJobs', JOB_ID)).toBeUndefined();
  });

  test('doc exists but body userId mismatch → 403', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: 'real_owner', url: URL, status: 'pending',
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: 'attacker', url: URL, adminBypass: true,
    });

    expect(result.code).toBe(403);
    expect(result.body.error).toMatch(/does not match stored doc/i);
    expect(result.shouldEnrich).toBe(false);
    // Doc unchanged
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.userId).toBe('real_owner');
    expect(doc.status).toBe('pending');
  });

  test('doc exists but body url mismatch → 403', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'pending',
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: 'https://malicious.url/', adminBypass: true,
    });

    expect(result.code).toBe(403);
  });

  test('matching pending doc → claims with triggeredBy=cloud_function + preserves fields', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID,
      url: URL,
      captionText: 'original caption',
      status: 'pending',
      createdAt: FakeTimestamp.fromMillis(5000),
      updatedAt: FakeTimestamp.fromMillis(5000),
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'overridden ignored',
      adminBypass: true,
    });

    expect(result.code).toBe(202);
    expect(result.shouldEnrich).toBe(true);

    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('cloud_function');
    expect(doc.captionText).toBe('original caption'); // preserved
    expect(doc.createdAt.toMillis()).toBe(5000); // preserved
    expect(doc.attempts).toBe(0);
  });

  test('matching doc already processing → 202 idempotent, no re-enrich', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'processing',
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true,
    });

    expect(result.code).toBe(202);
    expect(result.shouldEnrich).toBe(false);
  });

  test('matching doc already complete → 200 returns status', async () => {
    fs.seed('enrichmentJobs', JOB_ID, {
      userId: USER_ID, url: URL, status: 'complete',
    });

    const result = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true,
    });

    expect(result.code).toBe(200);
    expect(result.body.status).toBe('complete');
    expect(result.shouldEnrich).toBe(false);
  });
});
