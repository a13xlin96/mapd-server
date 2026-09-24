// Run only with the local Firestore emulator. No application credentials or
// deployed functions are used; real SDK snapshots/transactions exercise the
// shipped handler and migration against Firestore semantics.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const admin = require('firebase-admin');
const { createPinAccounting } = require('../../functions/lib/pinAccounting');
const { createAccountingMigration } = require('../../functions/lib/accountingMigration');
const { createContentIndex } = require('../../lib/contentIndex');

if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Local FIRESTORE_EMULATOR_HOST is required; live databases are forbidden');
}
const projectId = process.env.GCLOUD_PROJECT || 'demo-mapd-accounting';
if (!['demo-mapd-accounting', 'mapd-rules-test'].includes(projectId)) throw new Error('Test project required');
const app = admin.initializeApp({ projectId }, `accounting-test-${randomUUID()}`);
const db = app.firestore();
const accounting = createPinAccounting({ db, admin });
const migration = createAccountingMigration({ db, admin });
const missing = { exists: false, data: () => undefined };
const userId = `accounting-${randomUUID()}`;
const pinId = `pin-${randomUUID()}`;
const pinRef = db.collection('pins').doc(pinId);
const stats = async () => (await db.doc(`users/${userId}/stats/current`).get()).data();
const event = (before, after, id = randomUUID()) => ({ id, time: new Date().toISOString(),
  params: { pinId }, data: { before, after } });

after(async () => { await app.delete(); });

test('real Firestore: duplicate deliveries, index updates, migration and deletion converge', async () => {
  await migration.initializeCapture({ dryRun: false });
  await db.collection('users').doc(userId).set({ totalPins: 876 });
  await pinRef.set({ userId, placeId: 'fixture-place', category: 'food',
    url: 'https://www.instagram.com/reel/fixtureOne/?stkn=one', sources: [] });
  const created = await pinRef.get();
  await Promise.all([accounting.onPinWritten(event(missing, created)),
    accounting.onPinWritten(event(missing, created)),
    accounting.reconcile({ uid: userId, pinId })]);
  assert.equal((await stats()).currentPins, 1);
  assert.equal((await db.doc(`users/${userId}/interestProfile/v2`).get()).data().verifiedPinSaves, 1);
  assert.equal((await db.collection(`users/${userId}/saveEvents`).get()).size, 1);
  assert.equal((await db.collection('users').doc(userId).get()).data().totalPins, 876);

  await pinRef.update({ sources: [{ url: 'https://youtu.be/fixtureTwo' }] });
  const attached = await pinRef.get();
  await accounting.onPinWritten(event(created, attached));
  assert.equal((await stats()).currentPins, 1);
  assert.equal((await db.doc(`users/${userId}/interestProfile/v2`).get()).data().sourceAdditions, 1);

  const backfill = await migration.run({ uid: userId, dryRun: false, pageSize: 1, maxPages: 10 });
  assert.equal(backfill.complete, true);
  const parity = await migration.verify({ uid: userId, activate: true, dryRun: false, pageSize: 1 });
  assert.deepEqual(parity.errors, []);
  assert.equal(parity.activated, true);
  const result = await createContentIndex({ db }).lookup({ uid: userId, contentId: 'youtube:fixtureTwo' });
  assert.equal(result.indexReady, true);
  assert.equal(result.pins.length, 1);
  assert.equal(result.pins[0].id, pinId);
  assert.equal((await createContentIndex({ db }).lookup({ uid: 'unrelated-user', contentId: 'youtube:fixtureTwo' })).pins.length, 0);

  await pinRef.delete();
  await accounting.onPinWritten(event(attached, missing));
  await accounting.onPinWritten(event(missing, created));
  assert.equal((await stats()).currentPins, 0);
  assert.equal((await createContentIndex({ db }).lookup({ uid: userId, contentId: 'youtube:fixtureTwo' })).pins.length, 0);
  assert.equal((await db.doc(`users/${userId}/interestProfile/v2`).get()).data().verifiedPinSaves, 1);
});
