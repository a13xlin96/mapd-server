// Tests for computeTripSignalId + safeSignalIdRef — the F1+F2 fix for
// the Donostia/San Sebastián bug where a `/` in a city name made a
// Firestore document path that .doc() rejected synchronously, escaping
// the surrounding try/catch and marking the whole enrichment job failed.
//
// expo-server-sdk ESM workaround (same as buildPinFromDetails.test.js).
jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    async sendPushNotificationsAsync() { return []; }
  },
}));

const { computeTripSignalId, safeSignalIdRef } = require('../enrich.js');

describe('computeTripSignalId (F1 — Firestore path sanitization)', () => {
  test('strips forward slashes from city name (Donostia / San Sebastián)', () => {
    const id = computeTripSignalId('uid', 'Donostia / San Sebastián', 'Spain');
    expect(id).not.toContain('/');
    expect(id).toBe('uid_donostia_san_sebastián_spain');
  });

  test('strips backslashes too', () => {
    const id = computeTripSignalId('uid', 'Foo\\Bar', 'US');
    expect(id).not.toContain('\\');
  });

  test('strips periods (St. Louis would otherwise look like a path)', () => {
    const id = computeTripSignalId('uid', 'St. Louis', 'United States');
    expect(id).not.toContain('.');
    expect(id).toBe('uid_st_louis_united_states');
  });

  test('strips unicode control characters from city names', () => {
    // Input intentionally contains BEL (\x07) and US (\x1F) so the regex
    // actually fires. Prior version of this test used 'Hidden City' which
    // contained no control chars — tautological (per implementation-review 2b).
    const id = computeTripSignalId('uid', 'Hidden\x07City\x1FName', 'US');
    expect(id).not.toMatch(/[\x00-\x1f]/);
    expect(id).toBe('uid_hidden_city_name_us');
  });

  test('also sanitizes userId (defense in depth — implementation-review 1b)', () => {
    // Future-proofs against malformed userIds. Firebase Auth UIDs are
    // alphanumeric today, but the sanitization should not assume that.
    const id = computeTripSignalId('uid/with/slashes', 'Tokyo', 'Japan');
    expect(id).not.toMatch(/\//);
    expect(id).toBe('uid_with_slashes_tokyo_japan');
  });

  test('returns null when any segment normalizes to empty', () => {
    // Strings like "/", "...", "\t\n" all normalize to empty. Returning a
    // signalId like `uid__country` would collide with valid empty-city
    // saves (per implementation-review 2a).
    expect(computeTripSignalId('uid', '/', 'US')).toBeNull();
    expect(computeTripSignalId('uid', '...', 'US')).toBeNull();
    expect(computeTripSignalId('uid', '\t\n', 'US')).toBeNull();
    expect(computeTripSignalId('uid', 'Tokyo', '')).toBeNull();
    expect(computeTripSignalId('uid', '', 'Japan')).toBeNull();
    expect(computeTripSignalId('', 'Tokyo', 'Japan')).toBeNull();
  });

  test('coerces null/undefined inputs gracefully (does not throw)', () => {
    // Defensive: future callers may pass null/undefined. Should return
    // null rather than crash.
    expect(computeTripSignalId('uid', null, 'US')).toBeNull();
    expect(computeTripSignalId('uid', undefined, 'US')).toBeNull();
    expect(() => computeTripSignalId('uid', 42, 'US')).not.toThrow();
  });

  test('preserves accented characters (does NOT orphan existing docs for São Paulo, Düsseldorf, etc.)', () => {
    expect(computeTripSignalId('uid', 'São Paulo', 'Brazil')).toBe('uid_são_paulo_brazil');
    expect(computeTripSignalId('uid', 'Düsseldorf', 'Germany')).toBe('uid_düsseldorf_germany');
    expect(computeTripSignalId('uid', 'Bogotá', 'Colombia')).toBe('uid_bogotá_colombia');
  });

  test('collapses repeated whitespace and underscores', () => {
    expect(computeTripSignalId('uid', 'New   York', 'US')).toBe('uid_new_york_us');
  });

  test('trims leading and trailing underscores per segment', () => {
    expect(computeTripSignalId('uid', '/Tokyo/', 'Japan')).toBe('uid_tokyo_japan');
  });

  test('is byte-stable for existing common cities (regression guard)', () => {
    // These IDs must NOT change between the old whitespace-only impl and
    // the new sanitization, so existing /tripSignals docs are preserved.
    expect(computeTripSignalId('uid', 'New York', 'United States')).toBe('uid_new_york_united_states');
    expect(computeTripSignalId('uid', 'Queens County', 'United States')).toBe('uid_queens_county_united_states');
    expect(computeTripSignalId('uid', 'Tokyo', 'Japan')).toBe('uid_tokyo_japan');
  });
});

describe('safeSignalIdRef (F2 — defensive wrap of .doc())', () => {
  test('returns null when firestore is missing', () => {
    expect(safeSignalIdRef(null, 'whatever')).toBeNull();
  });

  test('returns null when signalId is empty', () => {
    const fakeFirestore = { collection: () => ({ doc: () => 'ref' }) };
    expect(safeSignalIdRef(fakeFirestore, '')).toBeNull();
    expect(safeSignalIdRef(fakeFirestore, null)).toBeNull();
    expect(safeSignalIdRef(fakeFirestore, undefined)).toBeNull();
  });

  test('returns the doc ref when .doc() succeeds', () => {
    const sentinel = { _kind: 'docRef' };
    const fakeFirestore = {
      collection: jest.fn(() => ({ doc: jest.fn(() => sentinel) })),
    };
    expect(safeSignalIdRef(fakeFirestore, 'valid_id')).toBe(sentinel);
    expect(fakeFirestore.collection).toHaveBeenCalledWith('tripSignals');
  });

  test('returns null when .doc() throws (the actual bug scenario)', () => {
    const fakeFirestore = {
      collection: () => ({
        doc: () => {
          // Mirrors the real Firestore error for unsanitized paths.
          throw new Error('Value for argument "documentPath" must point to a document');
        },
      }),
    };
    // This is the critical assertion: instead of bubbling the throw up to
    // runEnrichment's outer catch (and failing the whole job), we get null.
    expect(safeSignalIdRef(fakeFirestore, 'invalid/path')).toBeNull();
  });

  test('does not throw — bug class is structurally impossible', () => {
    const fakeFirestore = {
      collection: () => ({
        doc: () => { throw new Error('boom'); },
      }),
    };
    // No assertion needed beyond "doesn't throw"; the absence of a thrown
    // error IS the contract.
    expect(() => safeSignalIdRef(fakeFirestore, 'x')).not.toThrow();
  });
});
