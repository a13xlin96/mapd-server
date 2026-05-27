// LOAD-BEARING TEST: dual-trigger race for /enrich.
//
// The plan's whole correctness argument depends on this never going wrong:
// when the new feature flag is on, both the Cloud Function (admin bypass)
// and the in-app POST fallback (Bearer) can race to claim the SAME jobId.
// The Firestore transaction in claimEnrichmentJob must:
//   - Let exactly ONE caller win the pending→processing transition.
//   - Let the other caller see status='processing' and return 202 without
//     firing runEnrichment a second time.
//   - Preserve all client-set fields on the pending doc regardless of who wins.
//
// If this test ever fails, do NOT ship — every other safety claim collapses.

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

const JOB_ID = 'job_race_test';
const USER_ID = 'u_race';
const URL = 'https://www.tiktok.com/@maker/video/dual';

beforeEach(() => fs.reset());

function seedPending() {
  fs.seed('enrichmentJobs', JOB_ID, {
    userId: USER_ID,
    url: URL,
    captionText: 'race caption',
    status: 'pending',
    createdAt: FakeTimestamp.fromMillis(1000),
    updatedAt: FakeTimestamp.fromMillis(1000),
  });
}

describe('dual-trigger race on same jobId', () => {
  test('Cloud Function + in-app POST race → exactly one shouldEnrich=true winner', async () => {
    seedPending();

    // Simulate near-simultaneous arrival of:
    //  - admin bypass call (Cloud Function via X-Admin-Token)
    //  - direct Bearer call (in-app POST fallback)
    const [r1, r2] = await Promise.all([
      claimEnrichmentJob(fs, {
        jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'race caption',
        adminBypass: true,
      }),
      claimEnrichmentJob(fs, {
        jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'race caption',
        adminBypass: false,
      }),
    ]);

    const winners = [r1, r2].filter((r) => r.shouldEnrich === true);
    const losers = [r1, r2].filter((r) => r.shouldEnrich === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Both responses are 202 with status:'processing' (winner just transitioned,
    // loser sees the post-transition state).
    expect(r1.code).toBe(202);
    expect(r2.code).toBe(202);
    expect(r1.body.status).toBe('processing');
    expect(r2.body.status).toBe('processing');

    // Doc ends in processing, attempts:0, with one triggeredBy from the winner.
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.attempts).toBe(0);
    expect(['cloud_function', 'direct_post']).toContain(doc.triggeredBy);

    // Client-set immutable fields preserved.
    expect(doc.userId).toBe(USER_ID);
    expect(doc.url).toBe(URL);
    expect(doc.captionText).toBe('race caption');
    expect(doc.createdAt.toMillis()).toBe(1000);
  });

  test('three concurrent admin-path callers (Firebase auto-retry collision) → one winner', async () => {
    seedPending();

    const results = await Promise.all([
      claimEnrichmentJob(fs, { jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true }),
      claimEnrichmentJob(fs, { jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true }),
      claimEnrichmentJob(fs, { jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true }),
    ]);

    const winners = results.filter((r) => r.shouldEnrich === true);
    expect(winners).toHaveLength(1);
    // All three see 202 processing; only one would fire runEnrichment in production.
    results.forEach((r) => {
      expect(r.code).toBe(202);
      expect(r.body.status).toBe('processing');
    });

    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('cloud_function');
  });

  test('legacy-path race (no pre-existing doc, two Bearer POSTs) → one winner creates doc', async () => {
    // No fs.seed — both callers see missing doc; only one creates it.
    const [r1, r2] = await Promise.all([
      claimEnrichmentJob(fs, {
        jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'legacy',
        adminBypass: false,
      }),
      claimEnrichmentJob(fs, {
        jobId: JOB_ID, userId: USER_ID, url: URL, captionText: 'legacy',
        adminBypass: false,
      }),
    ]);

    const winners = [r1, r2].filter((r) => r.shouldEnrich === true);
    expect(winners).toHaveLength(1);

    // Doc exists exactly once.
    const doc = fs.read('enrichmentJobs', JOB_ID);
    expect(doc).toBeDefined();
    expect(doc.status).toBe('processing');
    expect(doc.triggeredBy).toBe('direct_post');
  });

  test('mixed race after winner advanced to processing → late entrant sees processing, no re-enrich', async () => {
    seedPending();
    // First caller wins.
    const r1 = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: true,
    });
    expect(r1.shouldEnrich).toBe(true);

    // Late entrant arrives after the transition completes.
    const r2 = await claimEnrichmentJob(fs, {
      jobId: JOB_ID, userId: USER_ID, url: URL, adminBypass: false,
    });
    expect(r2.shouldEnrich).toBe(false);
    expect(r2.code).toBe(202);
    expect(r2.body.status).toBe('processing');
  });
});
