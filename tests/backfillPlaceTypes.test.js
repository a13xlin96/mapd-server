// Places re-enrichment backfill tests — covers the cohort scope
// (category:'food' + missing types/primaryType), skip-if-populated
// idempotency, per-doc error isolation, dry-run safety, hasMore +
// cursor pagination, and the noApiSignal observability case.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

const mockGetPlaceDetails = jest.fn();
jest.mock('../enrich/places', () => ({
  getPlaceDetails: (...args) => mockGetPlaceDetails(...args),
  searchGooglePlaces: jest.fn(),
  findPlaceFromUrl: jest.fn(),
}));

const { getSharedFirestore } = require('./helpers/fakeFirestore');
const { runBackfillPlaceTypes } = require('../enrich/backfillPlaceTypes');

const fs = getSharedFirestore();

beforeEach(() => {
  fs.reset();
  mockGetPlaceDetails.mockReset();
});

function seedPin(id, data) {
  fs.seed('pins', id, data);
}

describe('runBackfillPlaceTypes', () => {
  test('re-enriches food pins missing types/primaryType from Places API', async () => {
    seedPin('pin-needs-enrich', {
      category: 'food',
      placeId: 'ChIJ_test_1',
    });
    mockGetPlaceDetails.mockResolvedValueOnce({
      types: ['italian_restaurant', 'restaurant'],
      primary_type: 'italian_restaurant',
    });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(1);
    expect(stats.updated).toBe(1);
    expect(stats.failures).toEqual([]);
    expect(mockGetPlaceDetails).toHaveBeenCalledWith('ChIJ_test_1');

    const after = fs.read('pins', 'pin-needs-enrich');
    expect(after.types).toEqual(['italian_restaurant', 'restaurant']);
    expect(after.primaryType).toBe('italian_restaurant');
  });

  test('skipAlreadyPopulated: pin with classifying types stays untouched (no API spend)', async () => {
    seedPin('pin-has-types', {
      category: 'food',
      placeId: 'ChIJ_skip',
      types: ['restaurant'],
      primaryType: 'restaurant',
    });
    seedPin('pin-has-primaryType-only', {
      category: 'food',
      placeId: 'ChIJ_skip_2',
      types: [],
      primaryType: 'cafe',
    });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(2);
    expect(stats.updated).toBe(0);
    expect(stats.skippedAlreadyPopulated).toBe(2);
    expect(mockGetPlaceDetails).not.toHaveBeenCalled();
  });

  // Codex R1: hasUsableTypeSignal (non-empty) was too lax — pins with
  // generic types like ['point_of_interest'] passed the skip but the
  // cuisine backfill can't classify them, leaving them stuck.
  // hasClassifyingTypeSignal requires the existing signal to actually
  // produce a non-'other' bucket.
  test('classifiability skip: generic-only types like ["point_of_interest"] DO get re-enriched', async () => {
    seedPin('pin-generic-types', {
      category: 'food',
      placeId: 'ChIJ_generic',
      types: ['point_of_interest', 'establishment'],
      primaryType: null,
    });
    mockGetPlaceDetails.mockResolvedValueOnce({
      types: ['italian_restaurant', 'restaurant'],
      primary_type: 'italian_restaurant',
    });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(1);
    expect(stats.updated).toBe(1);
    expect(stats.skippedAlreadyPopulated).toBe(0);
    expect(mockGetPlaceDetails).toHaveBeenCalledWith('ChIJ_generic');
    expect(fs.read('pins', 'pin-generic-types').types).toEqual(['italian_restaurant', 'restaurant']);
  });

  test('skipNoPlaceId: cannot re-enrich without a placeId', async () => {
    seedPin('pin-no-placeid', { category: 'food' });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.skippedNoPlaceId).toBe(1);
    expect(stats.updated).toBe(0);
    expect(mockGetPlaceDetails).not.toHaveBeenCalled();
  });

  test('cohort scope: ignores non-food pins entirely', async () => {
    seedPin('pin-museum', { category: 'attraction', placeId: 'ChIJ_museum' });
    seedPin('pin-park', { category: 'nature', placeId: 'ChIJ_park' });
    // Sanity: one food pin that DOES need re-enrich.
    seedPin('pin-food', { category: 'food', placeId: 'ChIJ_food' });
    mockGetPlaceDetails.mockResolvedValueOnce({ types: ['restaurant'], primary_type: 'restaurant' });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(1); // only the food pin reached the loop
    expect(stats.updated).toBe(1);
    expect(mockGetPlaceDetails).toHaveBeenCalledTimes(1);
  });

  test('skippedNoApiSignal: pin + placeId surfaced in noApiSignalSample for operator triage', async () => {
    seedPin('pin-bad-1', { category: 'food', placeId: 'ChIJ_stale_1' });
    seedPin('pin-bad-2', { category: 'food', placeId: 'ChIJ_stale_2' });
    mockGetPlaceDetails
      .mockResolvedValueOnce({ types: [], primary_type: null })
      .mockResolvedValueOnce({ types: [], primary_type: null });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(2);
    expect(stats.updated).toBe(0);
    expect(stats.skippedNoApiSignal).toBe(2);
    expect(stats.noApiSignalSample).toHaveLength(2);
    expect(stats.noApiSignalSample.map((s) => s.id).sort()).toEqual(['pin-bad-1', 'pin-bad-2']);
    expect(stats.noApiSignalSample[0]).toMatchObject({ id: 'pin-bad-1', placeId: 'ChIJ_stale_1' });
  });

  test('distributed lock: second concurrent invocation rejects (no duplicate Places spend)', async () => {
    seedPin('pin-slow', { category: 'food', placeId: 'ChIJ_slow' });
    // Make the Places call hang so the first invocation is still running
    // when the second fires.
    let resolveFirst;
    mockGetPlaceDetails.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

    const first = runBackfillPlaceTypes({ firestore: fs, dryRun: false });
    // Yield repeatedly so first acquires lock and reaches the awaited Places call.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await expect(runBackfillPlaceTypes({ firestore: fs, dryRun: false }))
      .rejects.toThrow(/Another backfill-place-types run is in progress/);

    resolveFirst({ types: ['cafe'], primary_type: 'cafe' });
    await first;
  });

  test('distributed lock: stale lock (>30 min old) is overwritten so crashes self-heal', async () => {
    fs.seed('configs', 'backfillLocks', {
      placeTypes: {
        jobId: 'crashed-job-from-before',
        startedAtMs: Date.now() - 31 * 60 * 1000, // 31 min ago — past TTL
      },
    });
    seedPin('pin-1', { category: 'food', placeId: 'ChIJ_1' });
    mockGetPlaceDetails.mockResolvedValueOnce({ types: ['cafe'], primary_type: 'cafe' });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });
    expect(stats.updated).toBe(1);
  });

  test('distributed lock: released after successful run so subsequent runs proceed', async () => {
    seedPin('pin-1', { category: 'food', placeId: 'ChIJ_1' });
    mockGetPlaceDetails.mockResolvedValue({ types: ['cafe'], primary_type: 'cafe' });

    await runBackfillPlaceTypes({ firestore: fs, dryRun: false });
    // Second run should not be blocked by leftover lock.
    const stats2 = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });
    expect(stats2.processed).toBe(1);
  });

  test('per-call timeout: a hanging Places call fails fast and the batch continues', async () => {
    seedPin('p1-hangs', { category: 'food', placeId: 'ChIJ_hang' });
    seedPin('p2-ok', { category: 'food', placeId: 'ChIJ_ok' });

    // First call hangs forever; second returns normally. Tiny timeout
    // (50ms) so the test runs in real time without fake-timer plumbing.
    mockGetPlaceDetails
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ types: ['cafe'], primary_type: 'cafe' });

    const stats = await runBackfillPlaceTypes({
      firestore: fs,
      dryRun: false,
      placesCallTimeoutMs: 50,
    });

    expect(stats.processed).toBe(2);
    expect(stats.updated).toBe(1);
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0].id).toBe('p1-hangs');
    expect(stats.failures[0].error).toMatch(/timeout/);
    expect(fs.read('pins', 'p2-ok').types).toEqual(['cafe']);
  });

  test('lock-theft detection: aborts loop when heartbeat finds a different jobId on the lock', async () => {
    for (let i = 0; i < 5; i++) {
      seedPin(`pin-${i}`, { category: 'food', placeId: `ChIJ_${i}` });
    }
    // Each Places call takes ~80ms. Heartbeat fires every 100ms so it
    // runs early in the batch. Mid-batch, a different operator overwrites
    // the lock — the heartbeat must detect 'not-owner' and abort.
    mockGetPlaceDetails.mockImplementation(() =>
      new Promise((r) => setTimeout(() => r({ types: ['cafe'], primary_type: 'cafe' }), 80))
    );

    // Schedule the lock theft to happen after the first pin completes
    // (~80ms) and before the run finishes. The next heartbeat (every
    // 100ms) will detect ownership loss.
    setTimeout(() => {
      fs.seed('configs', 'backfillLocks', {
        placeTypes: { jobId: 'rogue-operator', startedAtMs: Date.now() },
      });
    }, 120);

    const stats = await runBackfillPlaceTypes({
      firestore: fs,
      dryRun: false,
      lockStaleMs: 60_000,
      lockSafetyMarginMs: 1000,
      lockHeartbeatMs: 100,
    });

    expect(stats.abortedReason).toMatch(/lock ownership lost \(heartbeat/);
    // At least one pin processed before abort, but not all 5.
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    expect(stats.processed).toBeLessThan(5);
  });

  test('fail-closed on lock liveness: aborts loop before TTL expiry if heartbeat fails', async () => {
    for (let i = 0; i < 4; i++) {
      seedPin(`pin-${i}`, { category: 'food', placeId: `ChIJ_${i}` });
    }
    // Each Places call takes ~80ms. Lock TTL=300ms, safetyMargin=100ms,
    // so abort fires when sinceRenewMs > 200ms — which is after 2-3 pins.
    mockGetPlaceDetails.mockImplementation(() =>
      new Promise((r) => setTimeout(() => r({ types: ['cafe'], primary_type: 'cafe' }), 80))
    );

    const stats = await runBackfillPlaceTypes({
      firestore: fs,
      dryRun: false,
      lockStaleMs: 300,
      lockSafetyMarginMs: 100,
      lockHeartbeatMs: 10_000, // never fires during the test → no renewals
    });

    expect(stats.abortedReason).toMatch(/lock ownership likely lost/);
    // At least one pin processed before abort, but not all 4.
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    expect(stats.processed).toBeLessThan(4);
  });

  test('per-doc race guard: concurrent writer classifies mid-flight — no clobber', async () => {
    seedPin('pin-raced', { category: 'food', placeId: 'ChIJ_raced' });
    mockGetPlaceDetails.mockResolvedValueOnce({
      types: ['italian_restaurant'],
      primary_type: 'italian_restaurant',
    });

    // Simulate: between our Places call and the per-doc txn.get, a
    // concurrent writer populates types with a different signal.
    fs.setTxnReadHook(async (ref) => {
      if (ref.id === 'pin-raced') {
        await ref._setSync(
          { types: ['sushi_restaurant'], primaryType: 'sushi_restaurant' },
          { merge: true },
        );
        fs.setTxnReadHook(null);
      }
    });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.updated).toBe(0);
    expect(stats.raced).toBe(1);
    // The concurrent writer's value won — NOT our stale italian_restaurant.
    expect(fs.read('pins', 'pin-raced').types).toEqual(['sushi_restaurant']);
  });

  test('per-doc failure isolation: Places API throw or null does not abort batch', async () => {
    // Names chosen so alphabetical doc-id order matches the mock-resolve
    // order — backfill iterates docs sorted by __name__.
    seedPin('p1-ok', { category: 'food', placeId: 'ChIJ_ok' });
    seedPin('p2-throw', { category: 'food', placeId: 'ChIJ_throw' });
    seedPin('p3-null', { category: 'food', placeId: 'ChIJ_null' });

    mockGetPlaceDetails
      .mockResolvedValueOnce({ types: ['cafe'], primary_type: 'cafe' })
      .mockRejectedValueOnce(new Error('Places API 500'))
      .mockResolvedValueOnce(null);

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(1);
    expect(stats.failures).toHaveLength(2);
    expect(stats.failures.map((f) => f.id).sort()).toEqual(['p2-throw', 'p3-null']);
    expect(fs.read('pins', 'p1-ok').types).toEqual(['cafe']);
  });

  test('dry-run does not write or call Places API for already-populated pins', async () => {
    seedPin('pin-needs', { category: 'food', placeId: 'ChIJ_dry' });
    mockGetPlaceDetails.mockResolvedValueOnce({
      types: ['restaurant'], primary_type: 'restaurant',
    });

    const stats = await runBackfillPlaceTypes({ firestore: fs, dryRun: true });

    expect(stats.dryRun).toBe(true);
    expect(stats.updated).toBe(1); // dry-run still counts intended writes
    expect(stats.sample).toHaveLength(1);
    // The pin was NOT actually mutated.
    expect(fs.read('pins', 'pin-needs').types).toBeUndefined();
  });

  test('hasMore + cursor pagination, deletion-safe', async () => {
    for (let i = 0; i < 5; i++) {
      seedPin(`pin-${i}`, { category: 'food', placeId: `ChIJ_${i}` });
    }
    mockGetPlaceDetails.mockResolvedValue({ types: ['restaurant'], primary_type: 'restaurant' });

    const page1 = await runBackfillPlaceTypes({ firestore: fs, batchSize: 2, dryRun: false });
    expect(page1.hasMore).toBe(true);
    expect(page1.lastDocId).toBe('pin-1');

    const page2 = await runBackfillPlaceTypes({
      firestore: fs, batchSize: 2, startAfterDocId: page1.lastDocId, dryRun: false,
    });
    expect(page2.processed).toBe(2);
    expect(page2.lastDocId).toBe('pin-3');

    const page3 = await runBackfillPlaceTypes({
      firestore: fs, batchSize: 2, startAfterDocId: page2.lastDocId, dryRun: false,
    });
    expect(page3.processed).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  test('input validation: rejects bad batchSize and bad cursor', async () => {
    await expect(runBackfillPlaceTypes({ firestore: fs, batchSize: 0 }))
      .rejects.toThrow(/batchSize must be an integer/);
    await expect(runBackfillPlaceTypes({ firestore: fs, batchSize: 500 }))
      .rejects.toThrow(/batchSize must be an integer/);
    await expect(runBackfillPlaceTypes({ firestore: fs, startAfterDocId: '' }))
      .rejects.toThrow(/startAfterDocId must be a non-empty string/);
  });
});
