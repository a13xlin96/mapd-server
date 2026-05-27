// Backfill verifier — re-derives category + cuisine from already-stored
// types/primaryType. Covers cohort scoping, confidence guard, lost-update
// race protection, per-doc error isolation, hasMore continuation signal,
// split skip counters, and idempotency.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { runBackfillCategoryCuisine } = require('../enrich/backfillCategoryCuisine');

const fs = getSharedFirestore();

beforeEach(() => fs.reset());

function seedPin(id, data) {
  fs.seed('pins', id, data);
}

describe('runBackfillCategoryCuisine', () => {
  test('migrates legacy food pins into the 3-way split + cuisine', async () => {
    seedPin('pin-italian', {
      category: 'food',
      types: ['italian_restaurant', 'restaurant'],
      primaryType: 'italian_restaurant',
    });
    seedPin('pin-coffee', {
      category: 'food',
      types: ['coffee_shop', 'cafe'],
      primaryType: 'coffee_shop',
    });
    seedPin('pin-bar', {
      category: 'food',
      types: ['wine_bar', 'bar'],
      primaryType: 'wine_bar',
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(3);
    expect(stats.skippedNonCohort).toBe(0);
    expect(stats.skippedUnclassifiable).toBe(0);
    expect(stats.raced).toBe(0);
    expect(stats.failures).toEqual([]);

    expect(fs.read('pins', 'pin-italian')).toMatchObject({ category: 'restaurant', cuisine: 'italian' });
    expect(fs.read('pins', 'pin-coffee')).toMatchObject({ category: 'cafe', cuisine: 'other' });
    expect(fs.read('pins', 'pin-bar')).toMatchObject({ category: 'bar', cuisine: null });
  });

  test('skippedNonCohort: non-food pins (already-migrated, manual overrides, other categories) untouched', async () => {
    seedPin('pin-already-restaurant', {
      category: 'restaurant',
      cuisine: 'mexican',
      types: ['mexican_restaurant'],
      primaryType: 'mexican_restaurant',
    });
    seedPin('pin-manually-attraction', {
      category: 'attraction',
      types: ['restaurant'],
      primaryType: 'restaurant',
    });
    seedPin('pin-park', {
      category: 'nature',
      types: ['park'],
      primaryType: 'park',
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(0);
    expect(stats.skippedNonCohort).toBe(3);
    expect(stats.skippedUnclassifiable).toBe(0);

    expect(fs.read('pins', 'pin-already-restaurant').category).toBe('restaurant');
    expect(fs.read('pins', 'pin-manually-attraction').category).toBe('attraction');
    expect(fs.read('pins', 'pin-park').category).toBe('nature');
  });

  test('primaryType fallback: legacy food pins with empty types but valid primaryType DO migrate', async () => {
    // Regression for the 2026-05-25 dry-run finding — 80% of legacy food
    // pins had this shape and were being silently skipped.
    seedPin('pin-italian-pt', {
      category: 'food',
      types: [],
      primaryType: 'italian_restaurant',
    });
    seedPin('pin-bakery-pt', {
      category: 'food',
      types: [],
      primaryType: 'bakery',
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(2);
    expect(stats.updated).toBe(2);
    expect(stats.skippedUnclassifiable).toBe(0);
    expect(fs.read('pins', 'pin-italian-pt')).toMatchObject({ category: 'restaurant', cuisine: 'italian' });
    expect(fs.read('pins', 'pin-bakery-pt')).toMatchObject({ category: 'cafe', cuisine: 'other' });
  });

  test('skippedUnclassifiable: legacy food pins with NO usable signal preserved + surfaced for triage', async () => {
    seedPin('pin-empty-everything', { category: 'food' });
    seedPin('pin-null-everything', { category: 'food', types: null, primaryType: null });
    seedPin('pin-unknown', { category: 'food', types: ['totally_unknown_type'], primaryType: 'totally_unknown_type' });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(0);
    expect(stats.skippedNonCohort).toBe(0);
    expect(stats.skippedUnclassifiable).toBe(3);

    expect(stats.unclassifiableSample).toHaveLength(3);
    expect(stats.unclassifiableSample.map((s) => s.id).sort()).toEqual([
      'pin-empty-everything', 'pin-null-everything', 'pin-unknown',
    ]);

    expect(fs.read('pins', 'pin-empty-everything').category).toBe('food');
    expect(fs.read('pins', 'pin-null-everything').category).toBe('food');
    expect(fs.read('pins', 'pin-unknown').category).toBe('food');
  });

  test('split skipped counters: distinct cases counted separately', async () => {
    seedPin('food-good', { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    seedPin('food-bad', { category: 'food', types: [] });
    seedPin('non-food', { category: 'attraction', types: ['museum'] });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.updated).toBe(1);
    expect(stats.skippedNonCohort).toBe(1);
    expect(stats.skippedUnclassifiable).toBe(1);
  });

  test('dry-run returns the change preview without writing', async () => {
    seedPin('p1', {
      category: 'food',
      types: ['restaurant', 'mexican_restaurant'],
      primaryType: 'mexican_restaurant',
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: true });

    expect(stats.updated).toBe(1);
    expect(stats.dryRun).toBe(true);
    expect(stats.sample).toHaveLength(1);
    expect(stats.sample[0]).toMatchObject({
      id: 'p1',
      old: { category: 'food', cuisine: null },
      new: { category: 'restaurant', cuisine: 'mexican' },
    });

    expect(fs.read('pins', 'p1').category).toBe('food');
    expect(fs.read('pins', 'p1').cuisine).toBeUndefined();
  });

  test('idempotent: second live run returns updated:0', async () => {
    seedPin('p1', { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    seedPin('p2', { category: 'food', types: ['cafe'], primaryType: 'cafe' });

    await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });
    const second = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(second.processed).toBe(2);
    expect(second.updated).toBe(0);
    expect(second.skippedNonCohort).toBe(2);
  });

  test('lost-update race: concurrent writer flips category between query and txn — backfill respects the newer value', async () => {
    seedPin('pin-raced', { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    seedPin('pin-normal', { category: 'food', types: ['cafe'], primaryType: 'cafe' });

    // Simulate: between query snapshot and txn.get for pin-raced, a
    // concurrent writer changes its category to something else.
    fs.setTxnReadHook(async (ref) => {
      if (ref.id === 'pin-raced') {
        await ref._setSync(
          { category: 'attraction', curatedAt: FakeTimestamp.fromMillis(Date.now()) },
          { merge: true },
        );
        fs.setTxnReadHook(null);
      }
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(2);
    expect(stats.updated).toBe(1);
    expect(stats.raced).toBe(1);

    // The raced pin keeps the concurrent writer's value, NOT the backfill's.
    expect(fs.read('pins', 'pin-raced').category).toBe('attraction');
    // The other pin migrated normally.
    expect(fs.read('pins', 'pin-normal').category).toBe('cafe');
  });

  test('per-doc error isolation: one write failure does not abort the batch', async () => {
    seedPin('p-ok-1', { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    seedPin('p-fail', { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    seedPin('p-ok-2', { category: 'food', types: ['cafe'], primaryType: 'cafe' });

    fs.setWriteFailure((col, id) =>
      col === 'pins' && id === 'p-fail' ? new Error('simulated firestore conflict') : null
    );

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(2);
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0]).toMatchObject({ id: 'p-fail' });
    expect(stats.failures[0].error).toContain('simulated firestore conflict');

    expect(fs.read('pins', 'p-ok-1').category).toBe('restaurant');
    expect(fs.read('pins', 'p-ok-2').category).toBe('cafe');
    expect(fs.read('pins', 'p-fail').category).toBe('food');
  });

  test('stale-types race: types mutate mid-txn — backfill uses fresh classification', async () => {
    // Page snapshot says pin is a restaurant. Mid-txn, a concurrent writer
    // updates types to ['museum']. Backfill must NOT commit 'restaurant' —
    // the in-txn derivation should land on 'other' (unclassifiable) and skip.
    seedPin('pin-types-changed', {
      category: 'food',
      types: ['restaurant'],
      primaryType: 'restaurant',
    });

    fs.setTxnReadHook(async (ref) => {
      if (ref.id === 'pin-types-changed') {
        await ref._setSync(
          { types: ['museum'], primaryType: 'museum' },
          { merge: true },
        );
        fs.setTxnReadHook(null);
      }
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.updated).toBe(0);
    expect(stats.skippedUnclassifiable).toBe(1);
    // Pin retains the (race-mutated) types AND its category stays food —
    // backfill did NOT overwrite with the stale 'restaurant' classification.
    const after = fs.read('pins', 'pin-types-changed');
    expect(after.category).toBe('food');
    expect(after.types).toEqual(['museum']);
  });

  test('stale-types race: types change but new derivation is still valid — backfill uses fresh value', async () => {
    // Page snapshot says italian_restaurant. Mid-txn, types update to
    // japanese_restaurant. The backfill should commit cuisine='japanese',
    // not the stale 'italian'.
    seedPin('pin-cuisine-flipped', {
      category: 'food',
      types: ['italian_restaurant'],
      primaryType: 'italian_restaurant',
    });

    fs.setTxnReadHook(async (ref) => {
      if (ref.id === 'pin-cuisine-flipped') {
        await ref._setSync(
          { types: ['japanese_restaurant'], primaryType: 'japanese_restaurant' },
          { merge: true },
        );
        fs.setTxnReadHook(null);
      }
    });

    const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

    expect(stats.updated).toBe(1);
    expect(fs.read('pins', 'pin-cuisine-flipped')).toMatchObject({
      category: 'restaurant',
      cuisine: 'japanese',
    });
  });

  test('batchSize validation: rejects 0, negative, non-integer with a clear error', async () => {
    await expect(runBackfillCategoryCuisine({ firestore: fs, batchSize: 0 }))
      .rejects.toThrow(/batchSize must be an integer between 1 and 1000/);
    await expect(runBackfillCategoryCuisine({ firestore: fs, batchSize: -1 }))
      .rejects.toThrow(/batchSize must be an integer/);
    await expect(runBackfillCategoryCuisine({ firestore: fs, batchSize: 1.5 }))
      .rejects.toThrow(/batchSize must be an integer/);
    await expect(runBackfillCategoryCuisine({ firestore: fs, batchSize: 10_000 }))
      .rejects.toThrow(/batchSize must be an integer between 1 and 1000/);
  });

  test('cursor honored even when cursor doc was deleted between pages', async () => {
    // Pre-seed 4 food pins. Take page 1, delete the cursor doc, fetch page 2.
    // The cursor must still skip past the (now-deleted) boundary instead of
    // silently restarting from the top of the collection.
    for (let i = 0; i < 4; i++) {
      seedPin(`pin-${i}`, { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    }

    const page1 = await runBackfillCategoryCuisine({ firestore: fs, batchSize: 2, dryRun: false });
    expect(page1.processed).toBe(2);
    expect(page1.lastDocId).toBe('pin-1');

    // Operator deletes pin-1 between pages (user deleted their pin, e.g.).
    fs.collections.get('pins').delete('pin-1');

    const page2 = await runBackfillCategoryCuisine({
      firestore: fs, batchSize: 2, startAfterDocId: 'pin-1', dryRun: false,
    });
    // Should return pin-2 and pin-3 — NOT restart from pin-0.
    expect(page2.processed).toBe(2);
    expect(page2.lastDocId).toBe('pin-3');
  });

  test('cursor validation: rejects empty string and non-string types', async () => {
    await expect(runBackfillCategoryCuisine({ firestore: fs, startAfterDocId: '' }))
      .rejects.toThrow(/startAfterDocId must be a non-empty string/);
    await expect(runBackfillCategoryCuisine({ firestore: fs, startAfterDocId: 42 }))
      .rejects.toThrow(/startAfterDocId must be a non-empty string/);
    await expect(runBackfillCategoryCuisine({ firestore: fs, startAfterDocId: {} }))
      .rejects.toThrow(/startAfterDocId must be a non-empty string/);
  });

  test('hasMore is true when the page is full, false on the last page', async () => {
    for (let i = 0; i < 5; i++) {
      seedPin(`pin-${i}`, { category: 'food', types: ['restaurant'], primaryType: 'restaurant' });
    }

    const page1 = await runBackfillCategoryCuisine({ firestore: fs, batchSize: 2, dryRun: false });
    expect(page1.processed).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.lastDocId).toBe('pin-1');

    const page2 = await runBackfillCategoryCuisine({
      firestore: fs, batchSize: 2, startAfterDocId: page1.lastDocId, dryRun: false,
    });
    expect(page2.hasMore).toBe(true);

    const page3 = await runBackfillCategoryCuisine({
      firestore: fs, batchSize: 2, startAfterDocId: page2.lastDocId, dryRun: false,
    });
    expect(page3.processed).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  // Final-sweep mode: closes the `food` cohort before the client drops
  // `food` from the Category type. Stragglers that the strict pass
  // correctly refused (grocery_store etc.) get pushed onto whatever
  // mapToCategory returns — `other`, `shopping`, etc.
  describe('acceptAnyCategory=true (final-sweep mode)', () => {
    test('writes derived category for pins the strict pass would skip', async () => {
      seedPin('pin-supermarket', { category: 'food', types: ['supermarket'], primaryType: 'supermarket' });
      seedPin('pin-unknown', { category: 'food', types: ['totally_unknown_type'], primaryType: 'totally_unknown_type' });
      seedPin('pin-empty', { category: 'food' });

      const stats = await runBackfillCategoryCuisine({
        firestore: fs, dryRun: false, acceptAnyCategory: true,
      });

      expect(stats.processed).toBe(3);
      expect(stats.updated).toBe(3);
      expect(stats.skippedUnclassifiable).toBe(0);
      expect(stats.unclassifiableSample).toEqual([]);

      expect(fs.read('pins', 'pin-supermarket')).toMatchObject({ category: 'shopping', cuisine: null });
      expect(fs.read('pins', 'pin-unknown')).toMatchObject({ category: 'other', cuisine: null });
      expect(fs.read('pins', 'pin-empty')).toMatchObject({ category: 'other', cuisine: null });
    });

    test('still migrates classifiable food pins correctly', async () => {
      seedPin('pin-italian', {
        category: 'food',
        types: ['italian_restaurant', 'restaurant'],
        primaryType: 'italian_restaurant',
      });
      seedPin('pin-supermarket', { category: 'food', types: ['supermarket'], primaryType: 'supermarket' });

      const stats = await runBackfillCategoryCuisine({
        firestore: fs, dryRun: false, acceptAnyCategory: true,
      });

      expect(stats.updated).toBe(2);
      expect(fs.read('pins', 'pin-italian')).toMatchObject({ category: 'restaurant', cuisine: 'italian' });
      expect(fs.read('pins', 'pin-supermarket')).toMatchObject({ category: 'shopping', cuisine: null });
    });

    test('cohort guard still applies — non-food pins untouched', async () => {
      seedPin('pin-already-other', { category: 'other', types: ['totally_unknown_type'] });
      seedPin('pin-food-straggler', { category: 'food', types: ['supermarket'], primaryType: 'supermarket' });

      const stats = await runBackfillCategoryCuisine({
        firestore: fs, dryRun: false, acceptAnyCategory: true,
      });

      expect(stats.updated).toBe(1);
      expect(stats.skippedNonCohort).toBe(1);
      expect(fs.read('pins', 'pin-already-other').category).toBe('other');
      expect(fs.read('pins', 'pin-food-straggler').category).toBe('shopping');
    });

    test('dry-run previews the sweep without writing', async () => {
      seedPin('pin-supermarket', { category: 'food', types: ['supermarket'], primaryType: 'supermarket' });

      const stats = await runBackfillCategoryCuisine({
        firestore: fs, dryRun: true, acceptAnyCategory: true,
      });

      expect(stats.updated).toBe(1);
      expect(stats.dryRun).toBe(true);
      expect(stats.sample[0]).toMatchObject({
        id: 'pin-supermarket',
        old: { category: 'food', cuisine: null },
        new: { category: 'shopping', cuisine: null },
      });

      expect(fs.read('pins', 'pin-supermarket').category).toBe('food');
    });

    test('default (acceptAnyCategory omitted) preserves strict behavior', async () => {
      seedPin('pin-supermarket', { category: 'food', types: ['supermarket'], primaryType: 'supermarket' });

      const stats = await runBackfillCategoryCuisine({ firestore: fs, dryRun: false });

      expect(stats.updated).toBe(0);
      expect(stats.skippedUnclassifiable).toBe(1);
      expect(fs.read('pins', 'pin-supermarket').category).toBe('food');
    });
  });
});
