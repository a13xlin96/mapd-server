// Unit tests for runScrubOrphanMembers — the reverse-direction validation
// that deletes member docs whose corresponding pin no longer references
// the parent list.

function buildFirestoreMockForScrub(seedLists, seedMembers, seedPins) {
  // seedLists: array of {id}
  // seedMembers: { 'lists/{listId}/members/{pinId}': {...member} }
  // seedPins: { '{pinId}': {listIds: [...]} } (pinId → pin data; missing => pin doesn't exist)
  const memberDeletes = [];

  return {
    firestoreMock: {
      collection: (name) => {
        if (name === 'lists') {
          return {
            get: async () => ({
              docs: seedLists.map((l) => ({ id: l.id, data: () => l })),
            }),
            doc: (listId) => ({
              collection: (sub) => {
                if (sub !== 'members') throw new Error(`Unexpected sub: ${sub}`);
                return {
                  get: async () => {
                    const prefix = `lists/${listId}/members/`;
                    const docs = Object.keys(seedMembers)
                      .filter((p) => p.startsWith(prefix))
                      .map((p) => ({
                        id: p.slice(prefix.length),
                        data: () => seedMembers[p],
                      }));
                    return { empty: docs.length === 0, docs };
                  },
                  doc: (pinId) => ({
                    _path: `lists/${listId}/members/${pinId}`,
                    _listId: listId,
                    _pinId: pinId,
                  }),
                };
              },
            }),
          };
        }
        if (name === 'pins') {
          return {
            doc: (id) => ({ _path: `pins/${id}`, _pinId: id }),
          };
        }
        throw new Error(`Unsupported collection: ${name}`);
      },
      getAll: async (...refs) => refs.map((ref) => {
        const id = ref._pinId;
        if (id != null && seedPins[id] !== undefined) {
          return { exists: true, data: () => seedPins[id] };
        }
        return { exists: false, data: () => undefined };
      }),
      batch: () => {
        const ops = [];
        return {
          delete: (ref) => ops.push({ ref }),
          commit: async () => {
            for (const op of ops) {
              memberDeletes.push(op.ref._path);
              delete seedMembers[op.ref._path];
            }
          },
        };
      },
    },
    memberDeletes,
  };
}

describe('runScrubOrphanMembers', () => {
  let originalEnv;
  let originalSettle;
  beforeEach(() => {
    originalEnv = process.env.ADMIN_TOKEN;
    originalSettle = process.env.FREEZE_SETTLE_MS;
    process.env.ADMIN_TOKEN = 'secret';
    process.env.FREEZE_SETTLE_MS = '0';
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
        admin: { firestore: { FieldValue: { serverTimestamp: () => ({ _ts: true }) } } },
      }));
      mod = require('../lib/admin');
    });
    return mod;
  }

  it('deletes member docs whose pin.listIds does NOT reference the parent list', async () => {
    const lists = [{ id: 'L1' }];
    const members = {
      'lists/L1/members/pinA': { pinId: 'pinA', pinOwnerId: 'alice' }, // valid: pin's listIds includes L1
      'lists/L1/members/pinB': { pinId: 'pinB', pinOwnerId: 'bob' },   // ORPHAN: pin's listIds doesn't include L1
      'lists/L1/members/pinC': { pinId: 'pinC', pinOwnerId: 'carol' }, // ORPHAN: pin doesn't exist at all
    };
    const pins = {
      pinA: { listIds: ['L1', 'L2'] },
      pinB: { listIds: ['L2'] }, // missing L1
      // pinC: not in seedPins → !exists
    };
    const { firestoreMock, memberDeletes } = buildFirestoreMockForScrub(lists, members, pins);
    const { runScrubOrphanMembers } = loadAdminWith(firestoreMock);
    const stats = await runScrubOrphanMembers();

    expect(stats.membersScanned).toBe(3);
    expect(stats.orphansDeleted).toBe(2);
    expect(memberDeletes).toEqual(
      expect.arrayContaining(['lists/L1/members/pinB', 'lists/L1/members/pinC']),
    );
    expect(memberDeletes).not.toContain('lists/L1/members/pinA');
  });

  it('is idempotent — second pass on a clean dataset is a zero-write no-op', async () => {
    const lists = [{ id: 'L1' }];
    const members = {
      'lists/L1/members/pinA': { pinId: 'pinA', pinOwnerId: 'alice' },
    };
    const pins = { pinA: { listIds: ['L1'] } };
    const { firestoreMock, memberDeletes } = buildFirestoreMockForScrub(lists, members, pins);
    const { runScrubOrphanMembers } = loadAdminWith(firestoreMock);

    await runScrubOrphanMembers();
    await runScrubOrphanMembers();
    expect(memberDeletes).toHaveLength(0);
  });

  it('handles empty lists gracefully', async () => {
    const lists = [{ id: 'L1' }, { id: 'L2' }];
    const members = {}; // no members anywhere
    const pins = {};
    const { firestoreMock } = buildFirestoreMockForScrub(lists, members, pins);
    const { runScrubOrphanMembers } = loadAdminWith(firestoreMock);
    const stats = await runScrubOrphanMembers();

    expect(stats.membersScanned).toBe(0);
    expect(stats.orphansDeleted).toBe(0);
    expect(stats.errors).toHaveLength(0);
  });
});
