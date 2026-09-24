const { FakeFirestore, FakeTimestamp, makeAdmin } = require('./helpers/fakeFirestore');
const { createPinAccounting } = require('../functions/lib/pinAccounting');
const { createAccountingRepair } = require('../functions/lib/accountingRepair');
const { hash } = require('../functions/lib/contentIdentity');
const { parseArgs, main, cli } = require('../scripts/accounting-repair');

const BASE = { project: 'test-project', uid: 'alice' };
const ARGS = ['--project', BASE.project, '--uid', BASE.uid];
const SECRET = 'https://private.example/secret?token=private-token';
let db, admin, accounting, repair;
const snapshot = () => JSON.stringify([...db.collections].filter(([, docs]) => docs.size).map(([col, docs]) => [col, [...docs]]));
const profile = () => db.read('users/alice/interestProfile', 'v2');
const stats = () => db.read('users/alice/stats', 'current');
function inbox(pinId, { uid = 'alice', state = 'pending', ...patch } = {}) {
  db.seed('pins', pinId, { userId: uid, url: SECRET, category: 'sensitive-category' });
  const mutation = { uid, pinId, generation: '100', mutationId: 'created', eventTime: 100, createdAt: 100,
    facts: [{ type: 'pin_created', category: 'sensitive-category', city: 'private-city', occurredAtMs: 100 }] };
  const id = hash(`${uid}\0${pinId}\0${mutation.generation}\0${mutation.mutationId}`);
  db.seed('accountingInbox', id, { userId: uid, state, mutation, attempts: 0, lastError: SECRET, ...patch });
  return id;
}
const run = options => repair.run({ ...BASE, ...options });
const fakeSdk = () => ({ ...admin, initializeApp: jest.fn(() => ({ firestore: () => db, delete: jest.fn() })) });

beforeEach(() => {
  db = new FakeFirestore(); db.setNow(() => 100); db.strictReadOrder = true;
  admin = makeAdmin();
  db.seed('users', 'alice', {});
  db.seed('accountingControls', 'current', { captureEnabled: true, historyCoverageStart: FakeTimestamp.fromMillis(50) });
  accounting = createPinAccounting({ db, admin });
  repair = createAccountingRepair({ db, admin });
});

test('default report is bounded, read-only, account-scoped and contains no event data', async () => {
  inbox('a'); inbox('b', { state: 'awaiting_account' }); inbox('c', { state: 'needs_review' });
  inbox('foreign', { uid: 'bob' });
  const before = snapshot();
  const write = jest.fn();
  const report = await createAccountingRepair({ db, admin, repairMutation: write }).run({ ...BASE, pageSize: 2, maxPages: 1 });
  expect(report).toMatchObject({ dryRun: true, pages: 1, scanned: 2, attempted: 0, scanComplete: false, stoppedReason: 'page_limit' });
  expect(write).not.toHaveBeenCalled();
  expect(snapshot()).toBe(before);
  const text = JSON.stringify(report);
  for (const value of ['alice', 'bob', SECRET, 'private-city', 'sensitive-category', 'mutation', 'lastError']) expect(text).not.toContain(value);
  const next = await run({ pageSize: 2, maxPages: 1, cursor: report.nextCursor });
  expect(next.scanned).toBe(1);
  expect(next.scanComplete).toBe(true);
});

test('apply uses the existing repairMutation once per eligible record with explicit manual policy', async () => {
  const pending = inbox('pending'), awaiting = inbox('awaiting', { state: 'awaiting_account' });
  inbox('done', { state: 'complete' }); inbox('review', { state: 'needs_review' });
  const consume = jest.fn(accounting.repairMutation);
  const worker = createAccountingRepair({ db, admin, repairMutation: consume });
  const report = await worker.run({ ...BASE, apply: true });
  expect(report).toMatchObject({ attempted: 2, outcomes: { reconciled: 2 }, states: { needs_review: 1, complete: 1 } });
  expect(consume.mock.calls).toEqual([pending, awaiting].sort().map(id => [id, { manual: false }]));
  expect(stats().currentPins).toBe(2); expect(profile().verifiedPinSaves).toBe(2);
  await worker.run({ ...BASE, apply: true });
  expect(consume).toHaveBeenCalledTimes(2);
});

test('needs_review requires explicit retry; preview never writes or resets attempts', async () => {
  const id = inbox('review', { state: 'needs_review', attempts: 20 });
  expect((await run({ apply: true })).attempted).toBe(0);
  const before = snapshot();
  expect((await run({ retryNeedsReview: true })).eligible).toBe(1);
  expect(snapshot()).toBe(before);
  expect((await run({ apply: true, retryNeedsReview: true })).outcomes.reconciled).toBe(1);
  expect(db.read('accountingInbox', id)).toMatchObject({ state: 'complete', attempts: 20 });
  expect(profile().verifiedPinSaves).toBe(1);
});

test.each(['missing_account', 'disabled', 'tombstoned'])('%s stops before the blocker and is recoverable without losing history', async mode => {
  const ids = [inbox('a'), inbox('b')].sort();
  await accounting.repairMutation(ids[0]);
  if (mode === 'missing_account') await db.collection('users').doc('alice').delete();
  if (mode === 'disabled') await db.collection('accountingControls').doc('current').update({ captureEnabled: false });
  if (mode === 'tombstoned') db.seed('accountingTombstones', 'alice', {});
  const report = await run({ apply: true });
  expect(report.stoppedReason).toBe(mode === 'disabled' ? 'disabled' : 'inactive_account');
  expect(JSON.parse(Buffer.from(report.nextCursor, 'base64url').toString()).after).toBe(ids[0]);
  expect(db.read('accountingInbox', ids[1]).state).toBe(mode === 'disabled' ? 'pending' : 'awaiting_account');
  expect(profile().verifiedPinSaves).toBe(1);
  db.seed('users', 'alice', {});
  await db.collection('accountingTombstones').doc('alice').delete();
  await db.collection('accountingControls').doc('current').update({ captureEnabled: true });
  expect((await run({ apply: true, cursor: report.nextCursor })).outcomes.reconciled).toBe(1);
  expect(profile().verifiedPinSaves).toBe(2); expect(stats().currentPins).toBe(2);
});

test('projection commit followed by inbox acknowledgement failure replays without double-counting', async () => {
  const id = inbox('a');
  db.setWriteFailure(col => col === 'accountingInbox' ? new Error(SECRET) : null);
  const first = await run({ apply: true });
  expect(first).toMatchObject({ stoppedReason: 'failed', nextCursor: null, outcomes: { failed: 1 } });
  expect(JSON.stringify(first)).not.toContain(SECRET);
  expect(profile().verifiedPinSaves).toBe(1);
  expect(db.read('accountingInbox', id).state).toBe('pending');
  db.setWriteFailure(null);
  await run({ apply: true });
  expect(profile().verifiedPinSaves).toBe(1); expect(stats().currentPins).toBe(1);
  expect(db.collections.get('pinMutationReceipts').size).toBe(1);
  expect(db.collections.get('users/alice/saveEvents').size).toBe(1);
  expect(db.read('accountingInbox', id).state).toBe('complete');
});

test('concurrent repairs share receipts and never touch the extraction queue', async () => {
  inbox('a');
  db.seed('enrichmentJobs', 'failed', { status: 'failed', url: SECRET });
  const before = JSON.stringify([...db.collections.get('enrichmentJobs')]);
  await Promise.all([run({ apply: true }), run({ apply: true })]);
  expect(profile().verifiedPinSaves).toBe(1); expect(stats().currentPins).toBe(1);
  expect(JSON.stringify([...db.collections.get('enrichmentJobs')])).toBe(before);
});

test('exhausted retry budget stays needs_review, and retry failure advances attempts only once', async () => {
  const id = inbox('a', { attempts: 19 });
  db.setWriteFailure(col => col.endsWith('/interestProfile') ? new Error(SECRET) : null);
  expect((await run({ apply: true })).stoppedReason).toBe('needs_review');
  expect(db.read('accountingInbox', id)).toMatchObject({ state: 'needs_review', attempts: 20 });
  await run({ apply: true });
  expect(db.read('accountingInbox', id).attempts).toBe(20);
  expect((await run({ apply: true, retryNeedsReview: true })).stoppedReason).toBe('needs_review');
  expect(db.read('accountingInbox', id).attempts).toBe(21);
  expect(profile()).toBeUndefined();
});

test('pagination resumes after a deleted cursor and handles an exactly full final page', async () => {
  const ids = [inbox('a'), inbox('b'), inbox('c')].sort();
  const first = await run({ apply: true, pageSize: 1, maxPages: 1 });
  expect(first.scanned).toBe(1);
  await db.collection('accountingInbox').doc(ids[0]).delete();
  const second = await run({ apply: true, cursor: first.nextCursor, pageSize: 1, maxPages: 2 });
  expect(second).toMatchObject({ scanned: 2, scanComplete: false, stoppedReason: 'page_limit' });
  const last = await run({ apply: true, cursor: second.nextCursor, pageSize: 1, maxPages: 1 });
  expect(last).toMatchObject({ scanned: 0, scanComplete: true, nextCursor: null });
  expect(profile().verifiedPinSaves).toBe(3);
});

test('new insertions before a saved boundary are picked up by a fresh pass', async () => {
  const ids = [inbox('a'), inbox('b'), inbox('c')].sort();
  const firstItem = db.read('accountingInbox', ids[0]);
  await db.collection('accountingInbox').doc(ids[0]).delete();
  const first = await run({ apply: true, pageSize: 1, maxPages: 1 });
  db.seed('accountingInbox', ids[0], firstItem);
  await run({ apply: true, cursor: first.nextCursor });
  expect(profile().verifiedPinSaves).toBe(2);
  await run({ apply: true });
  expect(profile().verifiedPinSaves).toBe(3);
});

test('interruption inside a page returns the last safe boundary; a hard crash can replay a prior checkpoint', async () => {
  const ids = [inbox('a'), inbox('b'), inbox('c')].sort();
  const controller = new AbortController(), checkpoints = [];
  const worker = createAccountingRepair({ db, admin, repairMutation: async (...args) => {
    const result = await accounting.repairMutation(...args);
    controller.abort(); return result;
  } });
  const report = await worker.run({ ...BASE, apply: true, pageSize: 3, signal: controller.signal,
    onProgress: checkpoint => checkpoints.push(checkpoint) });
  expect(report).toMatchObject({ attempted: 1, stoppedReason: 'aborted' });
  expect(JSON.parse(Buffer.from(report.nextCursor, 'base64url').toString()).after).toBe(ids[0]);
  expect(checkpoints).toHaveLength(1);
  await run({ apply: true, cursor: report.nextCursor });
  await run({ apply: true });
  expect(profile().verifiedPinSaves).toBe(3);
});

test('pre-aborted runs do no reads or writes and query failures retain a resumable safe report', async () => {
  inbox('a'); const before = snapshot();
  const controller = new AbortController(); controller.abort();
  expect(await run({ apply: true, signal: controller.signal })).toMatchObject({ pages: 0, stoppedReason: 'aborted' });
  expect(snapshot()).toBe(before);
  const collection = db.collection.bind(db);
  jest.spyOn(db, 'collection').mockImplementation(name => {
    if (name !== 'accountingInbox') return collection(name);
    const query = { where: () => query, orderBy: () => query, limit: () => query,
      get: async () => { throw new Error(SECRET); } };
    return query;
  });
  const report = await run({ apply: true });
  expect(report).toMatchObject({ stoppedReason: 'query_failed', nextCursor: null });
  expect(JSON.stringify(report)).not.toContain(SECRET);
});

test.each(['foreign_mutation', 'wrong_receipt', 'unknown_state', 'unsafe_id'])('corrupt %s is never passed to the consumer or printed', async mode => {
  const id = inbox('a'), item = db.read('accountingInbox', id);
  if (mode === 'foreign_mutation') item.mutation.uid = 'bob';
  if (mode === 'wrong_receipt') item.mutation.mutationId = 'different';
  if (mode === 'unknown_state') item.state = SECRET;
  if (mode === 'unsafe_id') {
    await db.collection('accountingInbox').doc(id).delete();
    db.seed('accountingInbox', SECRET, item);
  }
  const consume = jest.fn();
  const report = await createAccountingRepair({ db, admin, repairMutation: consume }).run({ ...BASE, apply: true });
  expect(report).toMatchObject({ stoppedReason: 'invalid_record', nextCursor: null });
  expect(consume).not.toHaveBeenCalled(); expect(JSON.stringify(report)).not.toContain(SECRET);
});

test('cursor is bound to project/account/apply/review policy and rejects payload injection', async () => {
  inbox('a'); inbox('b');
  const { nextCursor: cursor } = await run({ pageSize: 1, maxPages: 1 });
  for (const patch of [{ project: 'other-project' }, { uid: 'bob' }, { apply: true }, { retryNeedsReview: true }]) {
    await expect(run({ cursor, ...patch })).rejects.toThrow('invalid_cursor');
  }
  const bad = JSON.parse(Buffer.from(cursor, 'base64url').toString()); bad.after = SECRET;
  await expect(run({ cursor: Buffer.from(JSON.stringify(bad)).toString('base64url') })).rejects.toThrow('invalid_cursor');
  await expect(run({ cursor: '%%%bad' })).rejects.toThrow('invalid_cursor');
});

test.each([
  [[], 'explicit_valid_project_required'],
  [['--project', 'test-project'], 'explicit_valid_uid_required'],
  [[...ARGS, '--page-size', '251'], 'invalid_page_size'],
  [[...ARGS, '--max-pages', '21'], 'invalid_max_pages'],
  [[...ARGS, '--max-pages', '0'], 'invalid_max_pages'],
  [[...ARGS, '--page-size', '1e2'], 'invalid_page_size'],
  [[...ARGS, '--apply', '--apply'], 'unknown_or_repeated_argument'],
  [[...ARGS, '--url', SECRET], 'unknown_or_repeated_argument'],
  [[...ARGS, '--cursor'], 'missing_argument_value'],
])('CLI rejects invalid arguments before any SDK use: %j', async (args, message) => {
  const loadAdmin = jest.fn();
  await expect(main(args, { loadAdmin })).rejects.toThrow(message);
  expect(loadAdmin).not.toHaveBeenCalled();
});

test('CLI emits safe checkpoint JSON, uses explicit project, closes SDK, and defaults to report', async () => {
  inbox('a'); const before = snapshot(), sdk = fakeSdk(), output = jest.fn();
  expect(await main(ARGS, { loadAdmin: () => sdk, output })).toBe(0);
  expect(sdk.initializeApp).toHaveBeenCalledWith({ projectId: BASE.project });
  expect(sdk.initializeApp.mock.results[0].value.delete).toHaveBeenCalledTimes(1);
  expect(snapshot()).toBe(before);
  const reports = output.mock.calls.map(([line]) => JSON.parse(line));
  expect(reports.map(item => item.type)).toEqual(['checkpoint', 'report']);
  expect(reports[1]).toMatchObject({ dryRun: true, attempted: 0, scanComplete: true });
  expect(JSON.stringify(reports)).not.toContain(SECRET);
  expect(parseArgs([...ARGS, '--retry-needs-review']).apply).toBe(false);
});

test('CLI help needs no SDK; runtime errors are redacted even during initialization or cleanup', async () => {
  const output = jest.fn(), errorOutput = jest.fn(), loadAdmin = jest.fn(() => { throw new Error(SECRET); });
  expect(await cli(['--help'], { loadAdmin, output, errorOutput })).toBe(0);
  expect(loadAdmin).not.toHaveBeenCalled();
  expect(await cli(ARGS, { loadAdmin, output, errorOutput })).toBe(1);
  expect(errorOutput).toHaveBeenLastCalledWith('accounting_repair_failed');
  const sdk = fakeSdk(); sdk.initializeApp.mockImplementation(() => ({ firestore: () => db,
    delete: async () => { throw new Error(SECRET); } }));
  expect(await cli(ARGS, { loadAdmin: () => sdk, output, errorOutput })).toBe(1);
  expect(JSON.stringify(errorOutput.mock.calls)).not.toContain(SECRET);
});

test('CLI exit codes distinguish skipped review, blockers and interruption', async () => {
  inbox('review', { state: 'needs_review' });
  const dependencies = { loadAdmin: fakeSdk, output: jest.fn() };
  expect(await main(ARGS, dependencies)).toBe(2);
  expect(await main([...ARGS, '--retry-needs-review'], dependencies)).toBe(0);
  await db.collection('users').doc('alice').delete();
  expect(await main([...ARGS, '--apply', '--retry-needs-review'], dependencies)).toBe(2);
  const controller = new AbortController(); controller.abort();
  expect(await main(ARGS, { ...dependencies, signal: controller.signal })).toBe(130);
});

test('targeted deployment scripts explicitly select server config and preserve enrichment deployment', () => {
  const config = require('../firebase.json'), { scripts } = require('../functions/package.json');
  expect(config.functions).toMatchObject({ source: 'functions', runtime: 'nodejs20' });
  expect(config.firestore).toBeUndefined();
  expect(scripts.deploy).toBe('firebase deploy --config ../firebase.json --only functions:enrichOnPendingJob');
  expect(scripts['deploy:enrichment']).toBe(scripts.deploy);
  expect(scripts['deploy:accounting']).toBe('firebase deploy --config ../firebase.json --only functions:accountingPinWritten,functions:accountingVisitWritten,functions:accountingUserDeleted');
  const entry = require('fs').readFileSync(require.resolve('../functions/index.js'), 'utf8');
  for (const name of ['accountingPinWritten', 'accountingVisitWritten', 'accountingUserDeleted', 'enrichOnPendingJob']) expect(entry).toContain(`exports.${name} =`);
});
