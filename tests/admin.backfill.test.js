// Unit tests for runBackfill: the algorithm that walks every pin and
// populates /lists/{listId}/members/{pinId}. Idempotency is the key
// property — running twice produces zero new writes on the second pass.

// Mock firebase-admin's firestore object with a controllable in-memory store.
// Supports both list-doc lookups (validation pre-pass) and member-doc lookups
// (idempotency check) via getAll.
//
// seedListExists: optional Set<listId>. Defaults to "all listIds referenced
// by seedPins exist" — pass an explicit Set to test stale-listId behavior.
function buildFirestoreMock(seedPins, seedMembers = {}, seedListExists = null) {
  const memberStore = new Map(Object.entries(seedMembers));
  const listStore = new Map();
  const writes = [];
  const batches = [];

  if (seedListExists === null) {
    for (const p of seedPins) {
      for (const lid of p.listIds || []) listStore.set(`lists/${lid}`, { id: lid });
    }
  } else {
    for (const lid of seedListExists) listStore.set(`lists/${lid}`, { id: lid });
  }

  function memberRef(listId, pinId) {
    return { _path: `lists/${listId}/members/${pinId}`, _listId: listId, _pinId: pinId };
  }
  function listRef(listId) {
    return { _path: `lists/${listId}`, _listId: listId };
  }

  // Transaction mock that mirrors batch semantics for writes and looks up
  // the right store on reads. Test override-able via mockTxnGet.
  const txnImpl = {
    get: async (ref) => {
      if (memberStore.has(ref._path)) {
        return { exists: true, data: () => memberStore.get(ref._path) };
      }
      if (listStore.has(ref._path)) {
        return { exists: true, data: () => listStore.get(ref._path) };
      }
      return { exists: false, data: () => undefined };
    },
    set: () => {}, // populated below per-call
  };
  let mockTxnFailureMode = null; // null | 'commit'

  return {
    firestoreMock: {
      collection: (name) => ({
        get: async () => {
          if (name === 'pins') {
            const docs = seedPins.map((p) => ({ id: p.id, data: () => p }));
            return { size: docs.length, forEach: (cb) => docs.forEach(cb), docs };
          }
          throw new Error(`Unsupported collection: ${name}`);
        },
        doc: (id) => {
          if (name === 'lists') {
            return Object.assign(listRef(id), {
              collection: (sub) => ({
                doc: (subId) => memberRef(id, subId),
              }),
            });
          }
          throw new Error(`Unsupported doc on collection: ${name}`);
        },
      }),
      getAll: async (...refs) => refs.map((ref) => {
        if (memberStore.has(ref._path)) {
          return { exists: true, data: () => memberStore.get(ref._path) };
        }
        if (listStore.has(ref._path)) {
          return { exists: true, data: () => listStore.get(ref._path) };
        }
        return { exists: false, data: () => undefined };
      }),
      batch: () => {
        const ops = [];
        return {
          set: (ref, data, _opts) => ops.push({ type: 'set', ref, data }),
          commit: async () => {
            for (const op of ops) {
              memberStore.set(op.ref._path, op.data);
              writes.push(op);
            }
            batches.push(ops.length);
          },
        };
      },
      runTransaction: async (fn) => {
        const txnOps = [];
        const txn = {
          get: txnImpl.get,
          set: (ref, data, _opts) => txnOps.push({ type: 'set', ref, data }),
        };
        const result = await fn(txn);
        // "Commit" (apply ops to the in-memory stores). Test failure mode
        // can simulate a commit error here.
        if (mockTxnFailureMode === 'commit') {
          throw new Error('simulated transaction commit failure');
        }
        for (const op of txnOps) {
          memberStore.set(op.ref._path, op.data);
          writes.push(op);
        }
        return result;
      },
    },
    writes,
    batches,
    memberStore,
    listStore,
    setMockTxnFailureMode: (mode) => { mockTxnFailureMode = mode; },
  };
}

describe('runBackfill', () => {
  let originalEnv;
  let originalSettle;
  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    originalSettle = process.env.FREEZE_SETTLE_MS;
    process.env.ADMIN_TOKEN = 'secret';
    process.env.FREEZE_SETTLE_MS = '0'; // skip settle delay in tests
    jest.resetModules();
  });
  afterEach(() => {
    process.env.ADMIN_TOKEN = originalEnv;
    process.env.FREEZE_SETTLE_MS = originalSettle;
  });

  function loadAdminWith(firestoreMock) {
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../lib/firestore', () => ({
        firestore: firestoreMock,
        admin: {
          firestore: {
            FieldValue: { serverTimestamp: () => ({ _ts: true }) },
          },
        },
      }));
      mod = require('../lib/admin');
    });
    return mod;
  }

  it('writes a member doc per (pin, listId) for pins with non-empty listIds', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1', 'L2'],
        createdAt: { toMillis: () => 1700000000000 },
      },
      {
        id: 'pinB',
        userId: 'bob',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000001000 },
      },
      {
        id: 'pinC',
        userId: 'alice',
        listIds: [], // pin with no list — must NOT trigger any write
        createdAt: { toMillis: () => 1700000002000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.pinsScanned).toBe(3);
    expect(stats.pinsWithListIds).toBe(2);
    expect(stats.membersWritten).toBe(3); // pinA→L1, pinA→L2, pinB→L1
    expect(stats.membersUnchanged).toBe(0);
    expect(writes).toHaveLength(3);

    // Validate one member doc shape
    const pinA_L1 = writes.find((w) => w.ref._path === 'lists/L1/members/pinA');
    expect(pinA_L1).toBeDefined();
    expect(pinA_L1.data).toMatchObject({
      pinId: 'pinA',
      pinOwnerId: 'alice',
      addedBy: 'alice',
      order: 1700000000000,
    });
  });

  it('is idempotent — second pass on the same data writes zero new docs', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);

    const first = await runBackfill();
    expect(first.membersWritten).toBe(1);

    const second = await runBackfill();
    expect(second.membersWritten).toBe(0);
    expect(second.membersUnchanged).toBe(1);
    expect(writes).toHaveLength(1); // only the first run's write committed
  });

  it('skips writes when ALL deterministic member fields match (pinId, pinOwnerId, addedBy, order, addedAt present)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins, {
      // All fields match the canonical shape — backfill should skip.
      'lists/L1/members/pinA': {
        pinId: 'pinA',
        pinOwnerId: 'alice',
        addedBy: 'alice',
        order: 1700000000000,
        addedAt: { _ts: true },
      },
    });
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(0);
    expect(stats.membersUnchanged).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('REWRITES when only pinOwnerId matches but order/addedBy are stale (Codex round-1 fix)', async () => {
    // A previous partial run / corrupted member doc has the right ownership
    // but missing or stale ordering/provenance. Backfill must repair it.
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins, {
      'lists/L1/members/pinA': {
        pinId: 'pinA',
        pinOwnerId: 'alice',
        // missing addedBy / order / addedAt — must trigger a rewrite
      },
    });
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1);
    expect(stats.membersUnchanged).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchObject({
      addedBy: 'alice',
      order: 1700000000000,
    });
  });

  it('rewrites a member doc when its pinOwnerId mismatches the pin (corruption recovery)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    // Existing member doc says someone else owns the pin — backfill rewrites.
    const { firestoreMock, writes } = buildFirestoreMock(seedPins, {
      'lists/L1/members/pinA': { pinId: 'pinA', pinOwnerId: 'wrong-owner' },
    });
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1);
    expect(writes[0].data.pinOwnerId).toBe('alice');
  });

  it('falls back to deterministic order=0 when pin has no createdAt', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        // no createdAt
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1);
    expect(writes[0].data.order).toBe(0);
  });

  it('order fallback for pins without createdAt is DETERMINISTIC (zero-diff on second pass — Codex round-2 fix)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        // no createdAt — falls back to deterministic order (0)
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);

    const first = await runBackfill();
    expect(first.membersWritten).toBe(1);
    expect(writes[0].data.order).toBe(0); // not Date.now()

    const second = await runBackfill();
    expect(second.membersWritten).toBe(0);
    expect(second.membersUnchanged).toBe(1);
    expect(writes).toHaveLength(1); // still just the one write from the first pass
  });

  it('skips and reports malformed listId values without crashing the run (Codex round-3 fix)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1', '', 'has/slash', null, 42], // 4 of 5 are invalid
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1); // only L1 produced a write
    expect(stats.invalidListRefs).toEqual([
      { pinId: 'pinA', listId: '' },
      { pinId: 'pinA', listId: 'has/slash' },
      { pinId: 'pinA', listId: null },
      { pinId: 'pinA', listId: 42 },
    ]);
    expect(writes).toHaveLength(1);
  });

  it('skips writes for stale listId references and surfaces them in stats.staleListRefs (Codex round-2 fix)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1', 'L_GHOST'], // L_GHOST does not exist
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    // Only L1 exists — L_GHOST is intentionally missing.
    const { firestoreMock, writes } = buildFirestoreMock(seedPins, {}, new Set(['L1']));
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1); // only L1 got a member doc
    expect(stats.staleListRefs).toEqual([
      { pinId: 'pinA', listId: 'L_GHOST' },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].ref._listId).toBe('L1');
  });

  it('skips and reports pins with missing/malformed userId (Codex round-4 fix)', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
      {
        id: 'pinB',
        // userId missing
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000001000 },
      },
      {
        id: 'pinC',
        userId: 42, // wrong type
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000002000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins);
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(1); // only pinA wrote
    expect(stats.invalidPinOwners).toEqual([
      { pinId: 'pinB' },
      { pinId: 'pinC' },
    ]);
    expect(writes).toHaveLength(1);
  });

  it('does NOT increment membersWritten when transaction commit throws (Codex round-1 + round-7)', async () => {
    // Simulate a Firestore error on transaction commit: stats.errors gets
    // the entry, stats.membersWritten stays 0 — operators must see
    // "failed run" not "partial success" in the response.
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const helpers = buildFirestoreMock(seedPins);
    helpers.setMockTxnFailureMode('commit');
    const { runBackfill } = loadAdminWith(helpers.firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(0);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0].error).toMatch(/simulated transaction commit failure/);
  });

  it('aborts the chunk when a parent list is deleted between pre-validation and transaction (Codex round-7 fix)', async () => {
    // Pre-pass sees L1 exists. After validation, L1 is deleted out-of-band.
    // Transactional re-read inside the chunk catches the missing parent and
    // surfaces the entry in staleListRefs without writing the orphan member.
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const helpers = buildFirestoreMock(seedPins);
    // Pre-validation pass uses getAll (which reads from listStore — populated).
    // We simulate a mid-run deletion by removing the list from listStore
    // before the transaction's txn.get fires. Override runTransaction to
    // delete the list entry just before invoking the user fn.
    const { firestoreMock, listStore, writes } = helpers;
    const originalRun = firestoreMock.runTransaction;
    firestoreMock.runTransaction = async (fn) => {
      listStore.delete('lists/L1'); // simulate concurrent delete
      return originalRun(fn);
    };
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(0);
    expect(stats.staleListRefs).toEqual([{ pinId: 'pinA', listId: 'L1' }]);
    expect(writes).toHaveLength(0);
  });
});
