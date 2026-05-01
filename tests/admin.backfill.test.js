// Unit tests for runBackfill: the algorithm that walks every pin and
// populates /lists/{listId}/members/{pinId}. Idempotency is the key
// property — running twice produces zero new writes on the second pass.

// Mock firebase-admin's firestore object with a controllable in-memory store.
function buildFirestoreMock(seedPins, seedMembers = {}) {
  const memberStore = new Map(Object.entries(seedMembers));
  const writes = [];
  const batches = [];

  function memberRef(listId, pinId) {
    const path = `lists/${listId}/members/${pinId}`;
    return {
      _path: path,
      _listId: listId,
      _pinId: pinId,
    };
  }

  return {
    firestoreMock: {
      collection: (name) => ({
        get: async () => {
          if (name === 'pins') {
            const docs = seedPins.map((p) => ({
              id: p.id,
              data: () => p,
            }));
            return { size: docs.length, forEach: (cb) => docs.forEach(cb), docs };
          }
          throw new Error(`Unsupported collection: ${name}`);
        },
        doc: (id) => ({
          collection: (sub) => ({
            doc: (subId) => memberRef(id, subId),
          }),
        }),
      }),
      getAll: async (...refs) => refs.map((ref) => {
        const data = memberStore.get(ref._path);
        return {
          exists: data != null,
          data: () => data,
        };
      }),
      batch: () => {
        const ops = [];
        const b = {
          set: (ref, data, _opts) => {
            ops.push({ type: 'set', ref, data });
          },
          commit: async () => {
            for (const op of ops) {
              memberStore.set(op.ref._path, op.data);
              writes.push(op);
            }
            batches.push(ops.length);
          },
        };
        return b;
      },
    },
    writes,
    batches,
    memberStore,
  };
}

describe('runBackfill', () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'secret';
    jest.resetModules();
  });
  afterEach(() => {
    process.env.ADMIN_TOKEN = originalEnv;
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

  it('skips writes when an existing member doc has matching pinId + pinOwnerId', async () => {
    const seedPins = [
      {
        id: 'pinA',
        userId: 'alice',
        listIds: ['L1'],
        createdAt: { toMillis: () => 1700000000000 },
      },
    ];
    const { firestoreMock, writes } = buildFirestoreMock(seedPins, {
      'lists/L1/members/pinA': { pinId: 'pinA', pinOwnerId: 'alice', addedBy: 'alice', order: 0 },
    });
    const { runBackfill } = loadAdminWith(firestoreMock);
    const stats = await runBackfill();

    expect(stats.membersWritten).toBe(0);
    expect(stats.membersUnchanged).toBe(1);
    expect(writes).toHaveLength(0);
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

  it('handles a pin with no createdAt by falling back to Date.now() for order', async () => {
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
    expect(typeof writes[0].data.order).toBe('number');
    expect(writes[0].data.order).toBeGreaterThan(0);
  });
});
