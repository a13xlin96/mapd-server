// Unit tests for runReconcilePinCounts: walks every list and updates
// pinCount to match the actual count of /lists/{listId}/members docs.

function buildFirestoreMock(seedLists, memberCountsByListId) {
  const updates = [];

  return {
    firestoreMock: {
      collection: (name) => {
        if (name === 'lists') {
          return {
            get: async () => {
              const docs = seedLists.map((l) => ({
                id: l.id,
                data: () => l,
              }));
              return {
                size: docs.length,
                docs,
                forEach: (cb) => docs.forEach(cb),
              };
            },
            doc: (id) => ({
              collection: (sub) => {
                if (sub !== 'members') throw new Error(`Unexpected sub: ${sub}`);
                return {
                  count: () => ({
                    get: async () => ({
                      data: () => ({ count: memberCountsByListId[id] ?? 0 }),
                    }),
                  }),
                };
              },
              update: async (patch) => {
                updates.push({ listId: id, patch });
              },
            }),
          };
        }
        throw new Error(`Unsupported collection: ${name}`);
      },
    },
    updates,
  };
}

describe('runReconcilePinCounts', () => {
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

  it('updates pinCount when stored count differs from actual member count', async () => {
    const seedLists = [
      { id: 'L1', pinCount: 5 }, // wrong (actual is 3)
      { id: 'L2', pinCount: 0 }, // wrong (actual is 7)
    ];
    const { firestoreMock, updates } = buildFirestoreMock(seedLists, { L1: 3, L2: 7 });
    const { runReconcilePinCounts } = loadAdminWith(firestoreMock);
    const stats = await runReconcilePinCounts();

    expect(stats.listsScanned).toBe(2);
    expect(stats.listsUpdated).toBe(2);
    expect(stats.listsAlreadyCorrect).toBe(0);
    expect(updates).toHaveLength(2);
    expect(updates.find((u) => u.listId === 'L1').patch.pinCount).toBe(3);
    expect(updates.find((u) => u.listId === 'L2').patch.pinCount).toBe(7);
  });

  it('skips lists where stored count already matches', async () => {
    const seedLists = [
      { id: 'L1', pinCount: 3 }, // already correct
      { id: 'L2', pinCount: 7 }, // already correct
    ];
    const { firestoreMock, updates } = buildFirestoreMock(seedLists, { L1: 3, L2: 7 });
    const { runReconcilePinCounts } = loadAdminWith(firestoreMock);
    const stats = await runReconcilePinCounts();

    expect(stats.listsAlreadyCorrect).toBe(2);
    expect(stats.listsUpdated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('treats lists with undefined pinCount as needing an update (initial backfill)', async () => {
    const seedLists = [
      { id: 'L1' /* no pinCount field */ },
    ];
    const { firestoreMock, updates } = buildFirestoreMock(seedLists, { L1: 4 });
    const { runReconcilePinCounts } = loadAdminWith(firestoreMock);
    const stats = await runReconcilePinCounts();

    expect(stats.listsUpdated).toBe(1);
    expect(updates[0].patch.pinCount).toBe(4);
  });

  it('is idempotent — second pass on already-correct lists writes zero', async () => {
    const seedLists = [
      { id: 'L1', pinCount: 3 },
    ];
    const { firestoreMock, updates } = buildFirestoreMock(seedLists, { L1: 3 });
    const { runReconcilePinCounts } = loadAdminWith(firestoreMock);

    await runReconcilePinCounts();
    await runReconcilePinCounts();

    expect(updates).toHaveLength(0);
  });
});
