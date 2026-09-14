const { FakeFirestore, FakeTimestamp, makeAdmin } = require('./helpers/fakeFirestore');
const { createPinAccounting } = require('../functions/lib/pinAccounting');
const { contentIdFor } = require('../functions/lib/contentIdentity');

let db, accounting, clock;
const time = ms => FakeTimestamp.fromMillis(ms);
const empty = { exists: false, data: () => undefined };
const ref = id => db.collection('pins').doc(id);
const stat = () => db.read('users/alice/stats', 'current');
const profile = () => db.read('users/alice/interestProfile', 'v2');
const rows = () => [...(db.collections.get('pinContentIndex') || new Map()).values()];
const event = (id, before, after, name = 'evt') => ({ id: name, time: new Date(clock).toISOString(), params: { pinId: id }, data: { before, after } });

async function create(id = 'p1', patch = {}) {
  await ref(id).set({ userId: 'alice', url: 'https://www.instagram.com/reel/abc/?stkn=one', sources: [], category: 'food', city: 'Kyoto', country: 'JP', ...patch });
  const e = event(id, empty, await ref(id).get());
  await accounting.onPinWritten(e);
  return e;
}

beforeEach(() => {
  db = new FakeFirestore(); clock = 10; db.setNow(() => clock); db.strictReadOrder = true;
  db.seed('users', 'alice', { totalPins: 876 });
  db.seed('accountingControls', 'current', { captureEnabled: true, historyCoverageStart: time(100) });
  clock = 200;
  accounting = createPinAccounting({ db, admin: makeAdmin() });
});

test('server-committed pin creates canonical count and one verified save without double-writing legacy total', async () => {
  const e = await create();
  await accounting.onPinWritten(e);
  await accounting.onPinWritten({ ...e, id: 'different-delivery-of-same-mutation' });
  expect(stat()).toMatchObject({ currentPins: 1, status: 'building', currentVisitedOwnedPins: 0 });
  expect(profile()).toMatchObject({ verifiedPinSaves: 1, sourceAdditions: 0, lastPinCity: 'Kyoto' });
  expect(db.read('users', 'alice').totalPins).toBe(876);
  expect(db.collections.get('users/alice/saveEvents').size).toBe(1);
  expect(rows()).toHaveLength(1);
});

test('a backfill creates inventory and index, not fabricated save history', async () => {
  clock = 50; await ref('old').set({ userId: 'alice', url: 'https://youtu.be/existing' });
  clock = 200;
  await accounting.reconcile({ uid: 'alice', pinId: 'old' });
  await accounting.onPinWritten(event('old', empty, await ref('old').get()));
  expect(stat().currentPins).toBe(1);
  expect(profile()).toBeUndefined();
  expect(rows()[0].contentIds).toEqual(['youtube:existing']);
});

test('backfill racing a new event counts inventory once and preserves the genuine event', async () => {
  await ref('p1').set({ userId: 'alice', url: 'https://youtu.be/new' });
  const e = event('p1', empty, await ref('p1').get());
  await Promise.all([accounting.reconcile({ uid: 'alice', pinId: 'p1' }), accounting.onPinWritten(e), accounting.onPinWritten(e)]);
  expect(stat().currentPins).toBe(1);
  expect(profile().verifiedPinSaves).toBe(1);
});

test('delete notification arriving before create never resurrects inventory but retains save history', async () => {
  await ref('p1').set({ userId: 'alice', url: 'https://youtu.be/first', category: 'food' });
  const original = await ref('p1').get();
  clock = 300; await ref('p1').delete();
  await accounting.onPinWritten(event('p1', original, empty, 'deleted'));
  await accounting.onPinWritten(event('p1', empty, original, 'created'));
  expect(stat().currentPins).toBe(0);
  expect(profile().verifiedPinSaves).toBe(1);
  expect(rows()).toEqual([]);
});

test('delete and recreate same id counts a new save; old generation delivery is harmless', async () => {
  const old = await create();
  clock = 250; await ref('p1').delete();
  clock = 300; await create('p1', { city: 'Taipei' });
  await accounting.onPinWritten(event('p1', old.data.after, empty, 'delayed-deletion'));
  await accounting.onPinWritten(old);
  expect(stat().currentPins).toBe(1);
  expect(profile()).toMatchObject({ verifiedPinSaves: 2, lastPinCity: 'Taipei' });
});

test('adding equivalent URL or changing thumbnail is not a new source; new source is separate from pin count', async () => {
  await create();
  const before = await ref('p1').get();
  clock = 250;
  await ref('p1').update({ sources: [{ url: 'https://instagram.com/reel/abc/?stkn=two', ogImage: 'new-image' }, { url: 'https://youtu.be/another' }] });
  const e = event('p1', before, await ref('p1').get(), 'source');
  await accounting.onPinWritten(e); await accounting.onPinWritten(e);
  expect(stat().currentPins).toBe(1);
  expect(profile()).toMatchObject({ verifiedPinSaves: 1, sourceAdditions: 1 });
  expect(rows()[0].contentIds).toEqual(['instagram:abc', 'youtube:another']);
});

test('source removals and deleting a pin remove index rows', async () => {
  await create('p1', { sources: [{ url: 'https://youtu.be/another' }] });
  clock = 250; const before = await ref('p1').get();
  await ref('p1').update({ url: '', sources: [] });
  await accounting.onPinWritten(event('p1', before, await ref('p1').get()));
  expect(rows()).toEqual([]);
  clock = 300; const prior = await ref('p1').get(); await ref('p1').delete();
  await accounting.onPinWritten(event('p1', prior, empty));
  expect(stat().currentPins).toBe(0);
  expect(profile().verifiedPinSaves).toBe(1);
});

test('a failed commit rolls back receipts, counters and index; retry applies effects once', async () => {
  db.setWriteFailure(col => col.endsWith('/interestProfile') ? new Error('temporary failure') : null);
  await expect(create()).rejects.toThrow('temporary failure');
  expect(stat()).toBeUndefined(); expect(rows()).toEqual([]);
  expect(db.collections.get('pinMutationReceipts')?.size || 0).toBe(0);
  db.setWriteFailure(null);
  await accounting.onPinWritten(event('p1', empty, await ref('p1').get()));
  expect(stat().currentPins).toBe(1); expect(profile().verifiedPinSaves).toBe(1);
});

test('backfill and events refuse missing, tombstoned or different owners', async () => {
  await create();
  const deletedUser = await db.collection('users').doc('alice').get();
  await db.collection('users').doc('alice').delete();
  await accounting.onUserDeleted({ params: { userId: 'alice' }, data: deletedUser });
  await expect(accounting.reconcile({ uid: 'alice', pinId: 'p1' })).resolves.toMatchObject({ status: 'inactive_account' });
  db.seed('users', 'bob', {});
  await expect(accounting.reconcile({ uid: 'bob', pinId: 'p1' })).resolves.toMatchObject({ status: 'not_owned' });
  expect(db.read('users/bob/stats', 'current')).toBeUndefined();
});

test('old event arrival cannot overwrite newer last-saved location', async () => {
  await ref('older').set({ userId: 'alice', city: 'Kyoto' });
  const old = event('older', empty, await ref('older').get(), 'old');
  clock = 400; await create('newer', { city: 'Taipei' });
  await accounting.onPinWritten(old);
  expect(profile()).toMatchObject({ verifiedPinSaves: 2, lastPinCity: 'Taipei' });
});

test('owned visit state uses current visit docs and converges under repeated notifications', async () => {
  await create('p1', { visited: true });
  expect(stat().currentVisitedOwnedPins).toBe(1);
  await db.collection('pins/p1/visits').doc('alice').set({ userId: 'alice', visited: false });
  await accounting.onVisitWritten({ params: { userId: 'alice', pinId: 'p1' } });
  await accounting.onVisitWritten({ params: { userId: 'alice', pinId: 'p1' } });
  expect(stat().currentVisitedOwnedPins).toBe(0);
});

test('trip statistics use verified signal ownership and the same receipt as the saved event', async () => {
  db.seed('tripSignals', 'trip', { userId: 'alice', pinCount: 99 });
  const e = await create('p1', { tripSignalIdAtSave: 'trip' }); await accounting.onPinWritten(e);
  const trip = [...db.collections.get('users/alice/tripSaveStats').values()][0];
  expect(trip.verifiedPinSaves).toBe(1);
  expect(db.read('tripSignals', 'trip').pinCount).toBe(99);
  db.seed('tripSignals', 'foreign', { userId: 'bob' });
  await create('p2', { tripSignalIdAtSave: 'foreign' });
  expect(db.collections.get('users/alice/tripSaveStats').size).toBe(1);
});

test('disabled capture does not initialize projections or modify legacy history', async () => {
  await db.collection('accountingControls').doc('current').delete();
  await create();
  expect(stat()).toBeUndefined(); expect(profile()).toBeUndefined(); expect(rows()).toEqual([]);
});

test('chunked index and source-history writes remain bounded for bulk source attachment', async () => {
  await create(); const before = await ref('p1').get(); clock = 500;
  await ref('p1').update({ sources: Array.from({ length: 250 }, (_, n) => ({ url: `https://youtu.be/video${n}` })) });
  await accounting.onPinWritten(event('p1', before, await ref('p1').get()));
  expect(rows()).toHaveLength(1);
  expect(profile().sourceAdditions).toBe(250);
  expect(db.collections.get('users/alice/saveEvents').size).toBe(2);
});

test.each(['https://evilinstagram.com/reel/abc', 'https://evil.test/?u=https://instagram.com/reel/abc', 'ftp://instagram.com/reel/abc'])('lookalikes never claim a social content identity: %s', url => {
  expect(contentIdFor(url)).toBeNull();
});

test('another owner may reuse a deleted document id without wedging either account', async () => {
  const old = await create();
  clock = 250; await ref('p1').delete(); db.seed('users', 'bob', {});
  clock = 300; await ref('p1').set({ userId: 'bob', url: 'https://youtu.be/bob' });
  await accounting.onPinWritten(event('p1', empty, await ref('p1').get(), 'bob-created'));
  await accounting.onPinWritten(event('p1', old.data.after, empty, 'alice-deleted'));
  expect(stat().currentPins).toBe(0);
  expect(db.read('users/bob/stats', 'current').currentPins).toBe(1);
  expect(rows().map(row => row.userId)).toEqual(['bob']);
});

test('delayed profile deletion does not disable a newer profile generation of the same auth uid', async () => {
  const oldUser = await db.collection('users').doc('alice').get();
  await db.collection('users').doc('alice').delete();
  clock = 250; await db.collection('users').doc('alice').set({});
  await accounting.onUserDeleted({ params: { userId: 'alice' }, data: oldUser });
  clock = 300; await create();
  expect(stat().currentPins).toBe(1);
  expect(profile().verifiedPinSaves).toBe(1);
});

test('temporarily missing profile leaves a repairable event instead of acknowledging an unrecorded save', async () => {
  await db.collection('users').doc('alice').delete();
  await create();
  const [id, inbox] = [...db.collections.get('accountingInbox')][0];
  expect(inbox.state).toBe('awaiting_account');
  clock = 300; await db.collection('users').doc('alice').set({});
  await accounting.repairMutation(id);
  expect(profile().verifiedPinSaves).toBe(1);
  expect(stat().currentPins).toBe(1);
});

test('valid large source arrays use bounded manifests and still contribute to inventory and history', async () => {
  await create(); const before = await ref('p1').get(); clock = 300;
  await ref('p1').update({ sources: Array.from({ length: 16000 }, (_, i) => ({ url: `https://a.co/${i}` })) });
  await accounting.onPinWritten(event('p1', before, await ref('p1').get(), 'large-update'));
  expect(stat().currentPins).toBe(1);
  expect(profile().sourceAdditions).toBe(16000);
  expect(rows()).toHaveLength(33);
  for (const [, inbox] of db.collections.get('accountingInbox')) expect(Buffer.byteLength(JSON.stringify(inbox))).toBeLessThan(10000);
  const sourceHistory = [...db.collections.get('users/alice/saveEvents').values()].find(item => item.type === 'source_added');
  const chunks = db.collections.get(`accountingInbox/${sourceHistory.sourceManifestId}/sources`);
  expect([...chunks.values()].reduce((n, chunk) => n + chunk.keys.length, 0)).toBe(16000);
});

test('legacy visit changes produce explicit assertion history, while native visit docs take precedence', async () => {
  await create(); const before = await ref('p1').get(); clock = 250;
  await ref('p1').update({ visited: true });
  await accounting.onPinWritten(event('p1', before, await ref('p1').get(), 'visit'));
  expect([...db.collections.get('users/alice/saveEvents').values()].some(item => item.type === 'visit_marked' && item.provenance === 'legacy_pin')).toBe(true);
  expect(stat().currentVisitedOwnedPins).toBe(1);
});

test('recreated pin ignores untouched visit children from the previous pin generation', async () => {
  await create(); clock = 250;
  await db.collection('pins/p1/visits').doc('alice').set({ userId: 'alice', visited: true });
  await accounting.onVisitWritten({ params: { userId: 'alice', pinId: 'p1' } });
  await ref('p1').delete(); clock = 300; await create('p1', { visited: false });
  expect(stat().currentVisitedOwnedPins).toBe(0);
});

test('legacy non-boolean visit values do not fabricate a marked-visit history', async () => {
  await create(); clock = 250;
  const visitRef = db.collection('pins/p1/visits').doc('alice');
  await visitRef.set({ userId: 'alice', visited: 'false' });
  await accounting.onVisitWritten({ id: 'bad-value', time: new Date(clock).toISOString(), params: { userId: 'alice', pinId: 'p1' }, data: { before: empty, after: await visitRef.get() } });
  expect(stat().currentVisitedOwnedPins).toBe(0);
  expect([...db.collections.get('users/alice/saveEvents').values()].filter(item => item.type === 'visit_marked')).toHaveLength(0);
});

test('delayed visit assertion survives pin reuse under another owner', async () => {
  await create(); clock = 250;
  const visitRef = db.collection('pins/p1/visits').doc('alice');
  await visitRef.set({ userId: 'alice', visited: true });
  const after = await visitRef.get();
  await ref('p1').delete(); clock = 300;
  await ref('p1').set({ userId: 'bob', url: 'https://youtu.be/bob' });
  await accounting.onVisitWritten({ id: 'delayed-visit', time: new Date(clock).toISOString(), params: { userId: 'alice', pinId: 'p1' }, data: { before: empty, after } });
  expect([...db.collections.get('users/alice/saveEvents').values()].some(item => item.type === 'visit_marked')).toBe(true);
  expect(stat().currentPins).toBe(0);
});
