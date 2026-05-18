const {
  runBackfillHomeLocations,
  isHighConfidenceCityMatch,
} = require('../lib/backfillHomeLocations');

// Tests assume GOOGLE_PLACES_API_KEY is set so the pre-flight check
// doesn't abort. The actual API isn't called — searchGooglePlaces is
// always passed in as a jest mock.
beforeAll(() => {
  process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';
});

describe('isHighConfidenceCityMatch', () => {
  test('accepts exact-name locality match', () => {
    expect(
      isHighConfidenceCityMatch({ name: 'Tokyo', types: ['locality'] }, 'Tokyo'),
    ).toBe(true);
  });

  test('case-insensitive matching', () => {
    expect(
      isHighConfidenceCityMatch(
        { name: 'tokyo, japan', types: ['locality'] },
        'TOKYO',
      ),
    ).toBe(true);
  });

  test('matches first-token on both sides ("Brooklyn" name vs "Brooklyn, NY" target)', () => {
    expect(
      isHighConfidenceCityMatch(
        { name: 'Brooklyn', types: ['locality'] },
        'Brooklyn, NY',
      ),
    ).toBe(true);
  });

  test('REJECTS loose-substring match ("New York" target vs "New York City" name)', () => {
    // "New York" might canonically mean NYC to a human but is ambiguous
    // (New York state vs city). Codex review on Task 13 flagged the prior
    // substring match as a silent-corruption risk for cases like this.
    expect(
      isHighConfidenceCityMatch(
        { name: 'New York City', types: ['locality'] },
        'New York',
      ),
    ).toBe(false);
  });

  test('REJECTS a business that happens to share a name (Tokyo Sushi vs Tokyo)', () => {
    expect(
      isHighConfidenceCityMatch(
        { name: 'Tokyo Sushi', types: ['restaurant', 'food'] },
        'Tokyo',
      ),
    ).toBe(false);
  });

  test('REJECTS even with city-like type if name does not match by first-token', () => {
    expect(
      isHighConfidenceCityMatch(
        { name: 'Osaka', types: ['locality'] },
        'Tokyo',
      ),
    ).toBe(false);
  });

  test('REJECTS broad political-only types (neighborhood, sublocality dropped per Codex review)', () => {
    expect(
      isHighConfidenceCityMatch(
        { name: 'Some Neighborhood', types: ['neighborhood', 'political'] },
        'Some Neighborhood',
      ),
    ).toBe(false);
  });

  test('rejects null / non-object / empty input', () => {
    expect(isHighConfidenceCityMatch(null, 'Tokyo')).toBe(false);
    expect(isHighConfidenceCityMatch({}, 'Tokyo')).toBe(false);
    expect(isHighConfidenceCityMatch({ name: 'Tokyo', types: ['locality'] }, '')).toBe(false);
  });
});

// Lightweight Firestore mock for the backfill scanner. Supports the
// compare-and-set runTransaction added per Codex review: the txn re-reads
// the user doc and writes only if homeLocation is still null. Per-user
// `concurrentHomeLocationWrite` simulates a client that populated
// homeLocation between the initial scan and the txn commit.
function buildFirestoreMock(users) {
  const updates = [];
  const docs = users.map((u) => ({
    id: u.uid,
    data: () => ({ homeCity: u.homeCity, homeLocation: u.homeLocation || null }),
    _user: u,
    ref: {
      _user: u,
      update: async (patch) => {
        updates.push({ uid: u.uid, patch });
      },
    },
  }));
  const queryObj = {
    orderBy: () => queryObj,
    limit: () => queryObj,
    startAfter: () => ({
      orderBy: () => ({ limit: () => ({ get: async () => ({ empty: true, size: 0, docs: [] }) }) }),
      get: async () => ({ empty: true, size: 0, docs: [] }),
    }),
    get: async () => ({ empty: docs.length === 0, size: docs.length, docs }),
  };
  return {
    collection: () => queryObj,
    runTransaction: async (fn) => {
      const txn = {
        get: async (ref) => {
          // Re-read returns the (possibly updated) current state.
          const fresh = ref._user.homeLocation || ref._user.concurrentHomeLocationWrite || null;
          return {
            exists: true,
            data: () => ({
              homeCity: ref._user.homeCity,
              homeLocation: fresh,
            }),
          };
        },
        update: (ref, patch) => {
          updates.push({ uid: ref._user.uid, patch });
        },
      };
      return await fn(txn);
    },
    _updates: updates,
  };
}

describe('runBackfillHomeLocations', () => {
  test('skips users that already have a structured homeLocation', async () => {
    const firestore = buildFirestoreMock([
      {
        uid: 'u1',
        homeCity: 'Tokyo',
        homeLocation: { placeId: 'x', displayName: 'Tokyo', latitude: 0, longitude: 0 },
      },
    ]);
    const searchGooglePlaces = jest.fn();
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.alreadyResolved).toBe(1);
    expect(stats.resolved).toBe(0);
    expect(searchGooglePlaces).not.toHaveBeenCalled();
    expect(firestore._updates).toHaveLength(0);
  });

  test('skips users with no homeCity AND no homeLocation', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: null }]);
    const searchGooglePlaces = jest.fn();
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.noHomeCity).toBe(1);
    expect(searchGooglePlaces).not.toHaveBeenCalled();
  });

  test('writes homeLocation on high-confidence match', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Tokyo' }]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([
      {
        place_id: 'ChIJ-tokyo',
        name: 'Tokyo',
        types: ['locality', 'political'],
        geometry: { location: { lat: 35.6762, lng: 139.6503 } },
      },
    ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.resolved).toBe(1);
    expect(firestore._updates).toEqual([
      {
        uid: 'u1',
        patch: {
          homeLocation: {
            placeId: 'ChIJ-tokyo',
            displayName: 'Tokyo',
            latitude: 35.6762,
            longitude: 139.6503,
          },
        },
      },
    ]);
  });

  test('dry-run does not write but still counts resolved', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Tokyo' }]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([
      {
        place_id: 'ChIJ-tokyo',
        name: 'Tokyo',
        types: ['locality'],
        geometry: { location: { lat: 35.6762, lng: 139.6503 } },
      },
    ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: true });
    expect(stats.resolved).toBe(1);
    expect(firestore._updates).toHaveLength(0);
  });

  test('compare-and-set: respects a user-picked homeLocation written between scan and txn', async () => {
    // Simulates the race Codex flagged: backfill scan saw homeLocation: null
    // at read time, then the user (or another client) populated homeLocation
    // before the txn commits. Backfill should observe the new value inside
    // the txn and skip the write.
    const firestore = buildFirestoreMock([
      {
        uid: 'u1',
        homeCity: 'Tokyo',
        concurrentHomeLocationWrite: {
          placeId: 'user-picked',
          displayName: 'My Custom Home',
          latitude: 35.6,
          longitude: 139.7,
        },
      },
    ]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([
      {
        place_id: 'ChIJ-tokyo',
        name: 'Tokyo',
        types: ['locality'],
        geometry: { location: { lat: 35.6762, lng: 139.6503 } },
      },
    ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.raceSkipped).toBe(1);
    expect(stats.resolved).toBe(0);
    expect(firestore._updates).toHaveLength(0);
  });

  test('aborts loudly when GOOGLE_PLACES_API_KEY is not set', async () => {
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Tokyo' }]);
      const searchGooglePlaces = jest.fn();
      await expect(
        runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false }),
      ).rejects.toThrow(/GOOGLE_PLACES_API_KEY not set/);
      expect(searchGooglePlaces).not.toHaveBeenCalled();
    } finally {
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  test('leaves user null when top result is ambiguous (business name match)', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Tokyo' }]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([
      { place_id: 'ChIJ-sushi', name: 'Tokyo Sushi', types: ['restaurant'] },
    ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.ambiguous).toBe(1);
    expect(stats.resolved).toBe(0);
    expect(firestore._updates).toHaveLength(0);
    expect(stats.sampleAmbiguous[0]).toMatchObject({ uid: 'u1', homeCity: 'Tokyo', topName: 'Tokyo Sushi' });
  });

  test('counts no-match when search returns empty', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Unknownville' }]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.noMatch).toBe(1);
  });

  test('counts searchFailed when searchGooglePlaces throws (one user fails, batch continues)', async () => {
    const firestore = buildFirestoreMock([
      { uid: 'u1', homeCity: 'Tokyo' },
      { uid: 'u2', homeCity: 'Osaka' },
    ]);
    const searchGooglePlaces = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([
        {
          place_id: 'ChIJ-osaka',
          name: 'Osaka',
          types: ['locality'],
          geometry: { location: { lat: 34.6937, lng: 135.5023 } },
        },
      ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.searchFailed).toBe(1);
    expect(stats.resolved).toBe(1);
  });

  test('skips writing when high-confidence match has no usable coords', async () => {
    const firestore = buildFirestoreMock([{ uid: 'u1', homeCity: 'Tokyo' }]);
    const searchGooglePlaces = jest.fn().mockResolvedValue([
      { place_id: 'ChIJ-x', name: 'Tokyo', types: ['locality'] }, // no geometry
    ]);
    const stats = await runBackfillHomeLocations({ firestore, searchGooglePlaces, dryRun: false });
    expect(stats.ambiguous).toBe(1);
    expect(stats.resolved).toBe(0);
  });
});
