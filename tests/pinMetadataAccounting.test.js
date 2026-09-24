const { FakeFirestore, FakeTimestamp, makeAdmin } = require('./helpers/fakeFirestore');
const { createPinAccounting, generationOf } = require('../functions/lib/pinAccounting');
const { metadataRefsFor } = require('../functions/lib/pinMetadataAccounting');
const { hash } = require('../functions/lib/contentIdentity');

let db, accounting, clock;
const empty = { exists: false, data: () => undefined };
const pinRef = (id = 'p1') => db.collection('pins').doc(id);
const profile = () => db.read('users/alice/interestProfile', 'v2');
const summary = () => db.read('users/alice/interestProfile', 'currentMetadata');
const docs = (prefix, uid = 'alice') => [...(db.collections.get(`users/${uid}/interestProfile`) || [])]
  .filter(([id]) => id.startsWith(prefix)).map(([, data]) => data);
const active = () => docs('metadataPin_').filter(item => item.exists);
const feature = (dimension, value) => docs('metadataFeature_').find(row => row.dimension === dimension && row.value === value)?.currentPins || 0;
const trip = city => docs('metadataTrip_').find(row => row.city === city)?.currentPins || 0;
const history = () => [...(db.collections.get('users/alice/saveEvents') || new Map()).values()];
const event = (before, after, pinId = 'p1', id = `event-${clock}`) => ({ id, time: new Date(clock).toISOString(), params: { pinId }, data: { before, after } });

async function create(patch = {}, id = 'p1', deliver = true) {
  await pinRef(id).set({ userId: 'alice', placeId: 'place-one', category: 'other', city: null, country: null,
    url: 'https://youtu.be/original', detailsSchemaVersion: 1, detailsState: 'pending', detailsRevision: 0,
    tripSignalIdAtSave: null, ...patch });
  const e = event(empty, await pinRef(id).get(), id);
  if (deliver) await accounting.onPinWritten(e);
  return e;
}

async function update(patch = {}, id = 'p1', deliver = true) {
  const before = await pinRef(id).get(); clock += 10;
  await pinRef(id).update(patch);
  const e = event(before, await pinRef(id).get(), id);
  if (deliver) await accounting.onPinWritten(e);
  return e;
}

const details = (patch = {}) => ({ detailsState: 'complete', detailsRevision: 1,
  detailsUpdatedAt: FakeTimestamp.fromMillis(clock), category: 'food', city: 'Kyoto', country: 'JP',
  rating: 4.6, dineIn: true, takeout: false, priceLevel: 0, types: ['restaurant'],
  paymentOptions: { acceptsCashOnly: false }, ...patch });

beforeEach(() => {
  db = new FakeFirestore(); clock = 10; db.setNow(() => clock); db.strictReadOrder = true;
  db.seed('users', 'alice', { totalPins: 123 });
  db.seed('accountingControls', 'current', { captureEnabled: true, historyCoverageStart: FakeTimestamp.fromMillis(100) });
  clock = 200; accounting = createPinAccounting({ db, admin: makeAdmin() });
});

test('pending -> complete projects business attributes, current profile and one trip without another save', async () => {
  await create({ rating: 9, dineIn: true }); // Pending placeholders are not evidence.
  const original = history();
  expect(active()[0].businessAttributes).toBeNull();
  expect(summary()).toMatchObject({ currentPins: 1, knownDetailsPins: 0 });
  expect(docs('metadataTrip_')).toEqual([]);
  const e = await update(details({ notes: 'private note', sources: [], visitedAt: 'private visit' }));
  const contribution = active()[0];
  expect(contribution).toMatchObject({ generation: '200', detailsRevision: 1, category: 'food',
    geography: { city: 'Kyoto', region: null, country: 'JP' }, tripSignalIdAtSave: null,
    businessAttributes: { rating: 4.6, dineIn: true, takeout: false, priceLevel: 0, types: ['restaurant'],
      paymentOptions: { acceptsCashOnly: false } } });
  for (const key of ['notes', 'sources', 'visitedAt', 'url']) expect(contribution).not.toHaveProperty(key);
  expect(summary()).toMatchObject({ currentPins: 1, knownDetailsPins: 1 });
  expect(feature('category', 'other')).toBe(0); expect(feature('category', 'food')).toBe(1);
  expect(trip('Kyoto')).toBe(1);
  expect(profile()).toMatchObject({ lastPinId: 'p1', lastPinGeneration: '200', lastPinCategory: 'food',
    lastPinCity: 'Kyoto', lastPinCountry: 'JP', verifiedPinSaves: 1, sourceAdditions: 0 });
  const revision = summary().revision;
  await Promise.all([accounting.onPinWritten(e), accounting.onPinWritten({ ...e, id: 'redelivery' }),
    accounting.reconcile({ uid: 'alice', pinId: 'p1' })]);
  expect(summary().revision).toBe(revision); expect(history()).toEqual(original);
  expect(db.read('users', 'alice').totalPins).toBe(123);
  expect(db.read('users/alice/stats', 'current').currentPins).toBe(1);
  expect((await pinRef().get()).data().tripSignalIdAtSave).toBeNull();
});

test('provisional geography moves exactly one contribution; historical trips and user status overrides stay immutable', async () => {
  db.seed('tripSignals', 'original-trip', { userId: 'alice', city: 'Osaka', status: 'returned', pinCount: 9 });
  await create({ city: 'Osaka', country: 'JP', tripSignalIdAtSave: 'original-trip' });
  const originalStats = db.read('users/alice/tripSaveStats', hash('original-trip'));
  const originalHistory = history();
  await update(details());
  expect(trip('Osaka')).toBe(0); expect(trip('Kyoto')).toBe(1);
  expect(feature('city', 'Osaka')).toBe(0); expect(feature('city', 'Kyoto')).toBe(1);
  expect(feature('country', 'JP')).toBe(1);
  expect(db.read('users/alice/tripSaveStats', hash('original-trip'))).toEqual(originalStats);
  expect(db.read('tripSignals', 'original-trip')).toMatchObject({ status: 'returned', pinCount: 9 });
  expect(history()).toEqual(originalHistory);
  expect(active()[0].tripSignalIdAtSave).toBe('original-trip');
  expect((await pinRef().get()).data().tripSignalIdAtSave).toBe('original-trip');
});

test('user-corrected category/location win over raw types and stale metadata event snapshots', async () => {
  await create();
  const hydrated = await update(details(), 'p1', false);
  const corrected = await update({ category: 'shopping', city: 'Taipei', country: 'TW',
    detailsRevision: 1, visitNote: 'untouched' }, 'p1', false);
  await accounting.onPinWritten(hydrated);
  await accounting.onPinWritten(corrected);
  expect(active()[0]).toMatchObject({ category: 'shopping', geography: { city: 'Taipei', country: 'TW' },
    businessAttributes: { types: ['restaurant'] } });
  expect(profile()).toMatchObject({ lastPinCategory: 'shopping', lastPinCity: 'Taipei' });
  expect(trip('Kyoto')).toBe(0); expect(trip('Taipei')).toBe(1);
  expect((await pinRef().get()).data().visitNote).toBe('untouched');
  expect(history()).toHaveLength(1);
});

test('coordinate corrections update current geography without another save or trip contribution', async () => {
  await create(details({ latitude: 35, longitude: 135 }));
  await update({ latitude: 25.03, longitude: 121.56, city: 'Taipei', country: 'TW' });
  expect(active()[0].geography).toMatchObject({ latitude: 25.03, longitude: 121.56, city: 'Taipei' });
  expect(trip('Kyoto')).toBe(0); expect(trip('Taipei')).toBe(1);
  await update({ latitude: 1000, longitude: null });
  expect(active()[0].geography).toMatchObject({ latitude: null, longitude: null });
  expect(trip('Taipei')).toBe(1); expect(profile().verifiedPinSaves).toBe(1);
});

test('late details from an older pin cannot overwrite a more recent saved-pin summary', async () => {
  await create(); clock = 300;
  await create({ category: 'park', city: 'Taipei', country: 'TW' }, 'newer');
  await update(details());
  expect(profile()).toMatchObject({ lastPinId: 'newer', lastPinGeneration: '300', lastPinCategory: 'park',
    lastPinCity: 'Taipei', verifiedPinSaves: 2 });
  expect(active()).toHaveLength(2); expect(trip('Kyoto')).toBe(1); expect(trip('Taipei')).toBe(1);
});

test('details delivered before the create event still refine its latest summary without a second metadata contribution', async () => {
  const created = await create({}, 'p1', false);
  await update(details());
  expect(profile()).toBeUndefined();
  const revision = summary().revision;
  await accounting.onPinWritten(created);
  expect(profile()).toMatchObject({ lastPinId: 'p1', lastPinGeneration: '200', lastPinCity: 'Kyoto', verifiedPinSaves: 1 });
  expect(summary().revision).toBe(revision); expect(trip('Kyoto')).toBe(1);
  expect(history()[0]).toMatchObject({ type: 'pin_created', category: 'other', city: null });
});

test('reverse delivery reads latest DB data even when its details revision is lower or unchanged', async () => {
  const created = await create();
  const old = await update(details({ detailsRevision: 10, city: 'Osaka' }), 'p1', false);
  const newest = await update(details({ detailsRevision: 1 }), 'p1', false);
  await Promise.all([accounting.onPinWritten(newest), accounting.onPinWritten(old), accounting.onPinWritten(created)]);
  expect(active()[0]).toMatchObject({ detailsRevision: 1, geography: { city: 'Kyoto' } });
  expect(docs('metadataTrip_')).toHaveLength(1); expect(trip('Kyoto')).toBe(1);
  expect(summary().revision).toBe(2); expect(history()).toHaveLength(1);
});

test('an already acknowledged notification still reconciles subsequent current DB metadata', async () => {
  const created = await create();
  await update(details(), 'p1', false);
  await accounting.onPinWritten(created);
  expect(active()[0].detailsState).toBe('complete');
  expect(profile().lastPinCity).toBe('Kyoto'); expect(history()).toHaveLength(1);
});

test('deletion subtracts one contribution and delayed details do not resurrect it', async () => {
  await create(); const hydrated = await update(details());
  const before = await pinRef().get(); clock = 300; await pinRef().delete();
  const deleted = event(before, empty);
  await Promise.all([accounting.onPinWritten(deleted), accounting.onPinWritten(hydrated), accounting.onPinWritten(deleted)]);
  expect(active()).toHaveLength(0); expect(docs('metadataPin_')).toHaveLength(1);
  expect(summary()).toMatchObject({ currentPins: 0, knownDetailsPins: 0 });
  expect(trip('Kyoto')).toBe(0); expect(feature('category', 'food')).toBe(0);
  expect(profile().verifiedPinSaves).toBe(1); expect(history().map(item => item.type)).toEqual(['pin_created', 'pin_deleted']);
});

test('delete and recreate transfers the contribution to actual createTime, ignoring client generations and stale deletes', async () => {
  const original = await create(); const hydrated = await update(details());
  const before = await pinRef().get(); clock = 300; await pinRef().delete();
  const deleted = event(before, empty);
  clock = 400;
  await create({ category: 'park', city: 'Taipei', country: 'TW', createdAt: FakeTimestamp.fromMillis(200),
    generation: '200', detailsGeneration: '200', detailsRevision: 0 });
  await Promise.all([accounting.onPinWritten(deleted), accounting.onPinWritten(hydrated), accounting.onPinWritten(original)]);
  expect(active()).toHaveLength(1); expect(active()[0]).toMatchObject({ generation: '400', category: 'park', detailsRevision: 0 });
  expect(docs('metadataPin_').find(item => item.generation === '200').exists).toBe(false);
  expect(summary()).toMatchObject({ currentPins: 1, knownDetailsPins: 0 });
  expect(trip('Kyoto')).toBe(0); expect(trip('Taipei')).toBe(1);
  expect(profile()).toMatchObject({ lastPinGeneration: '400', lastPinCity: 'Taipei', verifiedPinSaves: 2 });
});

test('generation replacement is correct even if the new create event has not arrived', async () => {
  const original = await create(); await update(details());
  clock = 300; await pinRef().delete(); clock = 400;
  const created = await create({ city: 'Taipei', country: 'TW' }, 'p1', false);
  await accounting.onPinWritten(original);
  expect(active()[0].generation).toBe('400'); expect(trip('Taipei')).toBe(1); expect(trip('Kyoto')).toBe(0);
  // The old generation's latest-save summary is not patched from the new pin.
  expect(profile()).toMatchObject({ lastPinGeneration: '200', lastPinCity: 'Kyoto' });
  await accounting.onPinWritten(created);
  expect(profile()).toMatchObject({ lastPinGeneration: '400', lastPinCity: 'Taipei', verifiedPinSaves: 2 });
});

test('multiple pins share current buckets without erasing another pin on correction or deletion', async () => {
  await create(details()); clock = 300; await create(details(), 'p2');
  expect(trip('Kyoto')).toBe(2); expect(feature('category', 'food')).toBe(2);
  await update({ city: null, country: null, category: null });
  expect(trip('Kyoto')).toBe(1); expect(feature('category', 'food')).toBe(1);
  expect(summary().currentPins).toBe(2); expect(active().find(row => row.pinId === 'p1').currentTripId).toBeNull();
  expect(profile().lastPinCity).toBe('Kyoto');
});

test.each(['pending', 'needs_action', 'invalid'])('%s details remain unknown while effective saved core fields still project', async state => {
  await create(details({ detailsState: state }));
  expect(active()[0].businessAttributes).toBeNull(); expect(active()[0].businessProvenance).toBe('unknown');
  expect(summary().knownDetailsPins).toBe(0); expect(trip('Kyoto')).toBe(1);
  expect(profile().verifiedPinSaves).toBe(1);
});

test('legacy full pins and backfilled inventory get current metadata without invented history', async () => {
  clock = 50;
  await pinRef().set({ userId: 'alice', category: 'food', city: 'Kyoto', country: 'JP', dineIn: false, rating: 4 });
  clock = 200; await accounting.reconcile({ uid: 'alice', pinId: 'p1' });
  expect(active()[0]).toMatchObject({ detailsState: 'legacy', businessAttributes: { dineIn: false, rating: 4 } });
  expect(profile()).toBeUndefined(); expect(history()).toEqual([]); expect(trip('Kyoto')).toBe(1);
});

test.each(['missing', 'tombstone', 'disabled'])('%s account/control blocks metadata writes and latest-summary changes', async mode => {
  await create(); const original = JSON.stringify(docs(''));
  const updated = await update(details(), 'p1', false);
  if (mode === 'missing') await db.collection('users').doc('alice').delete();
  if (mode === 'tombstone') db.seed('accountingTombstones', 'alice', { deletedGeneration: '10' });
  if (mode === 'disabled') await db.collection('accountingControls').doc('current').update({ captureEnabled: false });
  await accounting.onPinWritten(updated);
  expect(JSON.stringify(docs(''))).toBe(original);
});

test('a stale account tombstone does not block the current account generation', async () => {
  db.seed('accountingTombstones', 'alice', { deletedGeneration: '1' });
  await create(details()); expect(summary()).toMatchObject({ currentPins: 1, accountGeneration: '10' });
});

test('new account generation never adds a previous account generation contribution to its summary', async () => {
  await create(details()); clock = 400;
  await db.collection('users').doc('alice').delete(); await db.collection('users').doc('alice').set({});
  await accounting.reconcile({ uid: 'alice', pinId: 'p1' });
  expect(summary()).toMatchObject({ currentPins: 1, knownDetailsPins: 1, accountGeneration: '400' });
  expect(trip('Kyoto')).toBe(1); expect(active()[0].accountGeneration).toBe('400');
});

test('pin ID reused by another owner never copies business attributes across owners', async () => {
  const old = await create(details()); clock = 300; await pinRef().delete();
  db.seed('users', 'bob', {}); clock = 400;
  await create(details({ userId: 'bob', city: 'Paris', country: 'FR' }));
  await accounting.onPinWritten(event(old.data.after, empty));
  expect(active()).toHaveLength(0); expect(summary().currentPins).toBe(0);
  expect(docs('metadataPin_', 'bob')[0]).toMatchObject({ userId: 'bob', geography: { city: 'Paris' } });
  expect(docs('metadataPin_').some(item => item.geography.city === 'Paris')).toBe(false);
});

test('metadata write failure rolls back deltas, profile, receipts and head; inbox repair applies once', async () => {
  await create(); const initial = JSON.stringify(docs(''));
  const hydrated = await update(details(), 'p1', false);
  db.setWriteFailure((col, id) => id.startsWith('metadataPin_') ? new Error('metadata write failure') : null);
  await expect(accounting.onPinWritten(hydrated)).rejects.toThrow('metadata write failure');
  expect(JSON.stringify(docs(''))).toBe(initial);
  expect(db.collections.get('pinMutationReceipts').size).toBe(1);
  const [id] = [...db.collections.get('accountingInbox')].find(([, item]) => item.state === 'pending');
  db.setWriteFailure(null); await accounting.repairMutation(id);
  await accounting.onPinWritten(hydrated);
  expect(trip('Kyoto')).toBe(1); expect(summary()).toMatchObject({ currentPins: 1, knownDetailsPins: 1, revision: 2 });
  expect(profile().verifiedPinSaves).toBe(1); expect(history()).toHaveLength(1);
});

test('a retried transaction rereads a changed pin and never commits deltas from the aborted attempt', async () => {
  await create(); await update(details({ city: 'Osaka' }), 'p1', false);
  const runTransaction = db.runTransaction.bind(db); let retry = true;
  db.runTransaction = async fn => {
    if (retry) {
      retry = false;
      await expect(runTransaction(async txn => { await fn(txn); throw new Error('retry_conflict'); })).rejects.toThrow('retry_conflict');
      await pinRef().update({ city: 'Kyoto' });
    }
    return runTransaction(fn);
  };
  await accounting.reconcile({ uid: 'alice', pinId: 'p1' });
  expect(trip('Osaka')).toBe(0); expect(trip('Kyoto')).toBe(1); expect(summary().revision).toBe(2);
  expect(profile().lastPinCity).toBe('Kyoto');
});

test('source and visit mutations retain their own history without changing metadata contributions', async () => {
  await create(details()); const revision = summary().revision;
  await update({ sources: [{ url: 'https://youtu.be/another' }], visited: true });
  expect(profile()).toMatchObject({ verifiedPinSaves: 1, sourceAdditions: 1 });
  expect(history().map(item => item.type)).toEqual(['pin_created', 'source_added', 'visit_marked']);
  expect(summary().revision).toBe(revision); expect(trip('Kyoto')).toBe(1);
});

test('real SDK validates all projected documents offline and nanosecond creation generations stay distinct', async () => {
  const admin = require('firebase-admin');
  const sdk = new admin.firestore.Firestore({ projectId: 'demo-mapd-accounting' });
  const a = generationOf({ createTime: new admin.firestore.Timestamp(20, 1) });
  const b = generationOf({ createTime: new admin.firestore.Timestamp(20, 2) });
  expect(a).not.toBe(b);
  expect(metadataRefsFor(sdk, 'alice', 'p1', a).contribution.path)
    .not.toBe(metadataRefsFor(sdk, 'alice', 'p1', b).contribution.path);
  await create(); await update(details({ accessibilityOptions: { wheelchairAccessibleEntrance: true },
    openingPeriods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }] }));
  const convert = value => value instanceof FakeTimestamp ? admin.firestore.Timestamp.fromMillis(value.toMillis())
    : Array.isArray(value) ? value.map(convert) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)])) : value;
  const batch = sdk.batch();
  for (const [collection, rows] of db.collections) {
    for (const [id, data] of rows) batch.set(sdk.collection(collection).doc(id), convert(data));
  }
  // Serialize the real SDK writes without commit/RPC, credentials or network.
  for (const operation of batch._ops) expect(operation.op()).toHaveProperty('update');
  await sdk.terminate();
});
