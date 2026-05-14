// F59: seedFeatureFlags ensures /configs/featureFlags exists with a
// boolean freezeListMembershipWrites before any user-facing route can
// observe a missing-doc state. The route-level fail-closed check in
// lib/listMembership.js (round-6 F19) is deliberate security; this
// seed closes the operational hole on fresh deploys without weakening
// the check.

const { seedFeatureFlags } = require('../lib/firestore');

function buildSeedMock(initial) {
  // initial: null = doc missing; object = doc data
  let stored = initial;
  const writes = [];
  const ref = { _path: 'configs/featureFlags' };
  return {
    fs: {
      collection: () => ({ doc: () => ref }),
      runTransaction: async (fn) => {
        const txnOps = [];
        const txn = {
          get: async () => ({
            exists: stored !== null,
            data: () => (stored === null ? undefined : stored),
          }),
          set: (_ref, data) => txnOps.push({ type: 'set', data }),
          update: (_ref, data) => txnOps.push({ type: 'update', data }),
        };
        const result = await fn(txn);
        for (const op of txnOps) {
          if (op.type === 'update' && stored === null) {
            throw new Error('txn.update on missing doc');
          }
        }
        for (const op of txnOps) {
          writes.push({ type: op.type, data: op.data });
          if (op.type === 'set') {
            stored = op.data;
          } else if (op.type === 'update') {
            stored = { ...(stored || {}), ...op.data };
          }
        }
        return result;
      },
    },
    getStored: () => stored,
    getWrites: () => writes,
  };
}

describe('seedFeatureFlags (F59)', () => {
  it('returns skipped when firestore is null/undefined', async () => {
    const result = await seedFeatureFlags(null);
    expect(result.action).toBe('skipped');
  });

  it("creates the doc with { freezeListMembershipWrites: false } when it doesn't exist", async () => {
    const mock = buildSeedMock(null);
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('created');
    expect(mock.getStored()).toEqual({ freezeListMembershipWrites: false });
    expect(mock.getWrites()).toHaveLength(1);
    expect(mock.getWrites()[0].type).toBe('set');
  });

  it('adds the field when doc exists but field is missing', async () => {
    const mock = buildSeedMock({ someOtherField: 'preserved' });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('field-added');
    expect(mock.getStored()).toEqual({
      someOtherField: 'preserved',
      freezeListMembershipWrites: false,
    });
    expect(mock.getWrites()).toHaveLength(1);
    // Update path preserves sibling fields (transactional update, not set).
    expect(mock.getWrites()[0].type).toBe('update');
  });

  it('does NOT overwrite a non-boolean value (preserves fail-closed posture)', async () => {
    // Round-2 fix: a malformed value (e.g., an admin wrote
    // freezeListMembershipWrites: "true" as a string) must NOT be
    // coerced to false on restart — that would silently un-freeze a
    // migration. The route 409 trip-wire handles malformed state; the
    // admin must take corrective action.
    const mock = buildSeedMock({ freezeListMembershipWrites: 'truthy' });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('malformed-left-intact');
    expect(result.value).toBe('truthy');
    expect(mock.getStored().freezeListMembershipWrites).toBe('truthy');
    expect(mock.getWrites()).toHaveLength(0);
  });

  it('does NOT overwrite null (treated as malformed, not absent)', async () => {
    const mock = buildSeedMock({ freezeListMembershipWrites: null });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('malformed-left-intact');
    expect(mock.getStored().freezeListMembershipWrites).toBe(null);
    expect(mock.getWrites()).toHaveLength(0);
  });

  it('does NOT overwrite an existing true (mid-migration freeze must survive restart)', async () => {
    const mock = buildSeedMock({ freezeListMembershipWrites: true });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('already-present');
    expect(result.value).toBe(true);
    expect(mock.getStored().freezeListMembershipWrites).toBe(true);
    expect(mock.getWrites()).toHaveLength(0);
  });

  it('does NOT overwrite an existing false', async () => {
    const mock = buildSeedMock({ freezeListMembershipWrites: false });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('already-present');
    expect(result.value).toBe(false);
    expect(mock.getStored().freezeListMembershipWrites).toBe(false);
    expect(mock.getWrites()).toHaveLength(0);
  });

  it('preserves unrelated fields on the doc (e.g., useNewListMembership)', async () => {
    const mock = buildSeedMock({
      useNewListMembership: true,
      // freeze field intentionally absent
    });
    const result = await seedFeatureFlags(mock.fs);
    expect(result.action).toBe('field-added');
    expect(mock.getStored()).toEqual({
      useNewListMembership: true,
      freezeListMembershipWrites: false,
    });
  });
});
