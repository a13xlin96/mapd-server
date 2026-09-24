const { FakeFirestore, FakeTimestamp, makeAdmin } = require('./helpers/fakeFirestore');
const { createAccountingMigration } = require('../functions/lib/accountingMigration');
const { createPinAccounting } = require('../functions/lib/pinAccounting');
const { parseArgs, main } = require('../scripts/accounting-migrate');

let db, admin, migration, accounting;
const pin = (id, patch = {}) => db.seed('pins', id, { userId: 'alice', url: `https://youtu.be/${id}`, ...patch });
const stats = () => db.read('users/alice/stats', 'current');
const checkpoint = () => db.read('accountingMigrations', 'alice');
const backfill = options => migration.run({ uid: 'alice', dryRun: false, maxPages: 100, ...options });
const activate = options => migration.verify({ uid: 'alice', activate: true, dryRun: false, ...options });
const snapshot = () => JSON.stringify([...db.collections].filter(([, docs]) => docs.size).map(([name, docs]) => [name, [...docs]]));

beforeEach(() => {
  db = new FakeFirestore(); db.setNow(() => 100); db.strictReadOrder = true; admin = makeAdmin();
  db.seed('users', 'alice', { totalPins: 876 });
  db.seed('accountingControls', 'current', { captureEnabled: true, historyCoverageStart: FakeTimestamp.fromMillis(50) });
  accounting = createPinAccounting({ db, admin });
  migration = createAccountingMigration({ db, admin });
});

test('default report never writes; initialization needs apply and preserves original cutover', async () => {
  await db.collection('accountingControls').doc('current').delete(); pin('one');
  const before = snapshot();
  expect(await migration.run({ uid: 'alice' })).toMatchObject({ dryRun: true, valid: false });
  await migration.initializeCapture();
  expect(snapshot()).toBe(before);
  await migration.initializeCapture({ dryRun: false });
  const cutover = db.read('accountingControls', 'current').historyCoverageStart.toMillis();
  await db.collection('accountingControls').doc('current').update({ captureEnabled: false });
  await migration.initializeCapture({ dryRun: false });
  expect(db.read('accountingControls', 'current').historyCoverageStart.toMillis()).toBe(cutover);
});

test('backfill resumes checkpoint after deleted cursor, cleans stale contributions, activates explicitly without history', async () => {
  pin('a'); pin('b'); pin('c');
  const first = await backfill({ pageSize: 1, maxPages: 1 });
  expect(first.checkpoint).toMatchObject({ phase: 'pins', cursor: 'a' });
  await db.collection('pins').doc('a').delete();
  await backfill({ pageSize: 1 });
  expect(stats()).toMatchObject({ currentPins: 2, status: 'building' });
  expect(db.read('pinContributions', accounting.refsFor('alice', 'a').contribution.id).exists).toBe(false);
  expect(db.read('accountingAccounts', 'alice').indexReady).toBe(false);
  expect(await activate()).toMatchObject({ valid: true, activated: true, currentPins: 2 });
  expect(stats().status).toBe('ready');
  expect(db.read('accountingAccounts', 'alice').indexReady).toBe(true);
  expect(db.read('users/alice/interestProfile', 'v2')).toBeUndefined();
  expect(db.collections.get('users/alice/saveEvents')?.size || 0).toBe(0);
  expect(db.read('users', 'alice').totalPins).toBe(876);
});

test('interruption midway through a page preserves prior checkpoint and replay is idempotent', async () => {
  pin('a'); pin('b'); const controller = new AbortController(); let calls = 0;
  const interrupted = createAccountingMigration({ db, admin, reconcile: async options => {
    const result = await accounting.reconcile(options);
    if (++calls === 1) controller.abort();
    return result;
  } });
  await expect(interrupted.run({ uid: 'alice', dryRun: false, pageSize: 2, signal: controller.signal })).rejects.toThrow('migration_aborted');
  expect(checkpoint()).toMatchObject({ phase: 'pins', cursor: null, pages: 0 });
  expect(stats().currentPins).toBe(1);
  await backfill();
  expect(stats().currentPins).toBe(2);
  expect(await activate()).toMatchObject({ activated: true });
});

test('failed reconciliation does not advance checkpoint; retry completes', async () => {
  pin('a'); pin('b');
  db.setWriteFailure((collection, id) => collection === 'pinContributions' && id === accounting.refsFor('alice', 'b').contribution.id ? new Error('temporary') : null);
  await expect(backfill({ pageSize: 2 })).rejects.toThrow('temporary');
  expect(checkpoint().cursor).toBeNull(); expect(stats().currentPins).toBe(1);
  db.setWriteFailure(null);
  await backfill();
  expect((await activate()).activated).toBe(true); expect(stats().currentPins).toBe(2);
});

test('revision changes reject earlier validation even when the new inventory has caught up', async () => {
  pin('a'); await backfill(); const report = await migration.verify({ uid: 'alice' });
  pin('b'); await accounting.reconcile({ uid: 'alice', pinId: 'b' });
  expect(await activate({ expectedRevision: report.revision })).toMatchObject({ activated: false, errors: ['revision_changed'] });
  expect(db.read('accountingAccounts', 'alice').indexReady).toBe(false);
  expect((await activate()).activated).toBe(true);
});

test('actual pin, visit and index parity catch pending events even without a revision change', async () => {
  pin('a'); await backfill();
  const revision = stats().revision;
  await db.collection('pins').doc('a').update({ sources: [{ url: 'https://youtu.be/extra' }] });
  expect(await activate({ expectedRevision: revision })).toMatchObject({ valid: false, activated: false });
  await accounting.reconcile({ uid: 'alice', pinId: 'a' });
  await db.collection('pins/a/visits').doc('alice').set({ userId: 'alice', visited: true });
  expect((await activate()).errors).toContain('count_mismatch');
  await accounting.reconcile({ uid: 'alice', pinId: 'a' });
  expect((await activate()).activated).toBe(true);
});

test('corrupt totals or extra index rows are reported and never overwritten to force readiness', async () => {
  pin('a'); await backfill();
  await db.collection('users/alice/stats').doc('current').update({ currentPins: 999 });
  db.seed('pinContentIndex', 'orphan', { userId: 'alice', pinId: 'gone', contentIds: ['youtube:a'] });
  expect((await activate()).errors).toEqual(expect.arrayContaining(['count_mismatch', 'index_mismatch']));
  await backfill({ restart: true });
  expect(stats().currentPins).toBe(999);
  expect(db.read('accountingAccounts', 'alice').indexReady).toBe(false);
});

test('missed insertion before checkpoint requires another reconciliation pass before activation', async () => {
  pin('b'); pin('c'); await backfill({ pageSize: 1, maxPages: 1 });
  pin('a'); await backfill({ pageSize: 1 });
  expect((await activate()).errors).toContain('missing_contribution');
  await backfill({ restart: true, pageSize: 1 });
  expect((await activate()).activated).toBe(true);
  expect(stats().currentPins).toBe(3);
});

test('empty account activation is valid; activation never implicitly finishes an incomplete backfill', async () => {
  pin('a'); await backfill({ pageSize: 1, maxPages: 1 });
  expect((await activate()).errors).toContain('backfill_incomplete');
  db.seed('users', 'empty', {});
  await migration.run({ uid: 'empty', dryRun: false });
  expect(await migration.verify({ uid: 'empty', dryRun: false, activate: true })).toMatchObject({ currentPins: 0, activated: true });
});

test('account deletion or capture disable prevents progress and readiness', async () => {
  pin('a'); await backfill();
  db.seed('accountingTombstones', 'alice', {});
  await expect(backfill()).rejects.toThrow('inactive_account');
  expect((await activate()).errors).toContain('inactive_account');
  await db.collection('accountingTombstones').doc('alice').delete();
  await db.collection('accountingControls').doc('current').update({ captureEnabled: false });
  await expect(backfill()).rejects.toThrow('capture_not_initialized');
  expect((await activate()).activated).toBe(false);
});

test('checkpoint contention fails closed without regressing a concurrent worker', async () => {
  pin('a'); let once = false;
  const worker = createAccountingMigration({ db, admin, reconcile: async args => {
    const result = await accounting.reconcile(args);
    if (!once) { once = true; await db.collection('accountingMigrations').doc('alice').update({ epoch: 7 }); }
    return result;
  } });
  await expect(worker.run({ uid: 'alice', dryRun: false })).rejects.toThrow('checkpoint_changed');
  expect(checkpoint().epoch).toBe(7);
});

test('CLI requires explicit project and uid before loading any SDK or credentials', async () => {
  const loadAdmin = jest.fn();
  await expect(main(['--uid', 'alice'], { loadAdmin })).rejects.toThrow('explicit_valid_project_required');
  await expect(main(['--project', 'test-project'], { loadAdmin })).rejects.toThrow('explicit_valid_uid_required');
  expect(loadAdmin).not.toHaveBeenCalled();
  expect(() => parseArgs(['--project', 'test-project', '--uid', 'alice', '--restart'])).toThrow('restart_requires_backfill_apply');
});

test('CLI report and activation preview are read-only, using only the explicitly selected project', async () => {
  pin('a'); await backfill(); const before = snapshot(), output = jest.fn(), close = jest.fn();
  const fakeAdmin = { ...admin, initializeApp: jest.fn(() => ({ firestore: () => db, delete: close })) };
  expect(await main(['--project', 'test-project', '--uid', 'alice', '--activate'], { loadAdmin: () => fakeAdmin, output })).toBe(0);
  expect(fakeAdmin.initializeApp).toHaveBeenCalledWith({ projectId: 'test-project' });
  expect(snapshot()).toBe(before); expect(close).toHaveBeenCalled();
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ dryRun: true, activated: false });
});

test('live reconciliation between backfill pages converges without overwriting live totals or another account', async () => {
  pin('a'); pin('c'); db.seed('users', 'bob', {}); pin('bob-pin', { userId: 'bob' });
  await accounting.reconcile({ uid: 'bob', pinId: 'bob-pin' });
  const bobBefore = { ...db.read('users/bob/stats', 'current') };
  await backfill({ pageSize: 1, maxPages: 1 });
  pin('b'); await accounting.reconcile({ uid: 'alice', pinId: 'b' });
  await db.collection('pins').doc('a').delete();
  await accounting.reconcile({ uid: 'alice', pinId: 'a' });
  await backfill({ pageSize: 1 });
  expect(stats().currentPins).toBe(2);
  expect((await activate()).activated).toBe(true);
  expect(db.read('users/bob/stats', 'current')).toEqual(bobBefore);
  expect(db.read('accountingAccounts', 'bob')).toBeUndefined();
});

test('activation readiness markers commit atomically and failed activation can be retried', async () => {
  pin('a'); await backfill();
  db.setWriteFailure(collection => collection === 'accountingAccounts' ? new Error('activation_failure') : null);
  await expect(activate()).rejects.toThrow('activation_failure');
  expect(stats().status).toBe('building');
  expect(db.read('accountingAccounts', 'alice').indexReady).toBe(false);
  db.setWriteFailure(null);
  expect((await activate()).activated).toBe(true);
});

test('deletion during a backfill stops checkpointing and cannot mark the account ready', async () => {
  pin('a'); pin('b');
  const interrupted = createAccountingMigration({ db, admin, reconcile: async options => {
    const result = await accounting.reconcile(options);
    db.seed('accountingTombstones', 'alice', {});
    return result;
  } });
  await expect(interrupted.run({ uid: 'alice', dryRun: false })).rejects.toThrow('reconcile_inactive_account');
  expect(checkpoint().pages).toBe(0);
  expect((await activate()).activated).toBe(false);
});
