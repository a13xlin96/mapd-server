const { createPinAccounting, generationOf, millis, SCHEMA } = require('./pinAccounting');
const { validId, hash, identities, indexRows } = require('./contentIdentity');
const { summarizeInterestBaseline } = require('./interestBaseline');
const dataOf = snap => snap.exists ? snap.data() : null;
const revisionOf = stats => stats?.revision || 0;
const abortIfNeeded = signal => { if (signal?.aborted) throw new Error('migration_aborted'); };

function createAccountingMigration({ db, admin, reconcile = createPinAccounting({ db, admin }).reconcile }) {
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const controlRef = db.collection('accountingControls').doc('current');
  const refs = uid => ({ user: db.collection('users').doc(uid), tombstone: db.collection('accountingTombstones').doc(uid),
    stats: db.collection(`users/${uid}/stats`).doc('current'), account: db.collection('accountingAccounts').doc(uid),
    checkpoint: db.collection('accountingMigrations').doc(uid) });
  const checkUid = uid => { if (!validId(uid)) throw new Error('invalid_user_id'); };
  const checkActive = (control, user, tombstone) => {
    if (!user.exists || (tombstone.exists && (!tombstone.data().deletedGeneration || tombstone.data().deletedGeneration === generationOf(user)))) throw new Error('inactive_account');
    if (control?.captureEnabled !== true || !Number.isFinite(millis(control.historyCoverageStart))) throw new Error('capture_not_initialized');
  };

  async function initializeCapture({ dryRun = true } = {}) {
    if (dryRun) return { dryRun: true, control: dataOf(await controlRef.get()) };
    return db.runTransaction(async txn => {
      const current = dataOf(await txn.get(controlRef));
      if (current && !Number.isFinite(millis(current.historyCoverageStart))) throw new Error('invalid_existing_cutover');
      // A later invocation can re-enable capture, but can never move its boundary.
      const historyCoverageStart = current?.historyCoverageStart || admin.firestore.Timestamp.now();
      txn.set(controlRef, { captureEnabled: true, historyCoverageStart, schemaVersion: SCHEMA }, { merge: true });
      return { dryRun: false, historyCoverageStart };
    });
  }

  async function pageAll(txn, collection, uid, pageSize, signal) {
    const docs = []; let cursor = null;
    while (true) {
      abortIfNeeded(signal);
      let query = db.collection(collection).where('userId', '==', uid).orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await txn.get(query);
      docs.push(...page.docs);
      if (page.size < pageSize) return docs;
      cursor = page.docs[page.docs.length - 1].id;
    }
  }

  // Read validation and activation share one Firestore transaction. This also
  // validates actual pins/visits, not just a revision advanced by delayed triggers.
  // Large accounts may hit transaction deadlines: fail closed and retry during
  // quieter periods; never replace totals with a nontransactional scan result.
  async function verify({ uid, activate = false, dryRun = true, expectedRevision, pageSize = 250, signal } = {}) {
    checkUid(uid); checkPageSize(pageSize);
    const r = refs(uid);
    return db.runTransaction(async txn => {
      abortIfNeeded(signal);
      const control = dataOf(await txn.get(controlRef));
      const user = await txn.get(r.user), tombstone = await txn.get(r.tombstone);
      const stats = dataOf(await txn.get(r.stats));
      const checkpoint = dataOf(await txn.get(r.checkpoint));
      const revision = revisionOf(stats);
      const pins = await pageAll(txn, 'pins', uid, pageSize, signal);
      const contributions = await pageAll(txn, 'pinContributions', uid, pageSize, signal);
      const rows = await pageAll(txn, 'pinContentIndex', uid, pageSize, signal);
      const expectedRows = new Map(), expectedContributions = new Map();
      let visitedCount = 0;
      for (const pin of pins) {
        abortIfNeeded(signal);
        const data = pin.data(), keys = identities(data), generation = generationOf(pin);
        const visit = await txn.get(db.collection(`pins/${pin.id}/visits`).doc(uid));
        const validVisit = visit.exists && visit.data().userId === uid && millis(visit.updateTime) >= millis(pin.createTime);
        const visited = validVisit ? visit.data().visited === true : data.visited === true;
        visitedCount += Number(visited);
        const pinRows = indexRows(uid, pin.id, keys);
        pinRows.forEach(row => expectedRows.set(row.id, row));
        expectedContributions.set(pin.id, { generation, visited,
          digest: hash(JSON.stringify({ exists: true, generation, visited, keys })),
          rowIds: pinRows.map(row => row.id) });
      }
      const errors = [];
      const addError = code => { if (!errors.includes(code)) errors.push(code); };
      if (!user.exists || (tombstone.exists && (!tombstone.data().deletedGeneration || tombstone.data().deletedGeneration === generationOf(user)))) addError('inactive_account');
      if (control?.captureEnabled !== true || !Number.isFinite(millis(control?.historyCoverageStart))) addError('capture_not_initialized');
      if (expectedRevision !== undefined && revision !== expectedRevision) addError('revision_changed');
      if (!stats || stats.currentPins !== pins.length || stats.currentVisitedOwnedPins !== visitedCount) addError('count_mismatch');
      for (const contribution of contributions) {
        const data = contribution.data(), expected = expectedContributions.get(data.pinId);
        if (expected) {
          if (data.exists !== true || data.digest !== expected.digest || data.generation !== expected.generation
            || data.visited !== expected.visited || JSON.stringify(data.indexRowIds) !== JSON.stringify(expected.rowIds)) addError('contribution_mismatch');
          expectedContributions.delete(data.pinId);
        } else if (data.exists !== false || data.visited !== false || data.indexRowIds?.length !== 0) addError('stale_contribution');
      }
      if (expectedContributions.size) addError('missing_contribution');
      for (const row of rows) {
        const expected = expectedRows.get(row.id), data = row.data();
        if (!expected || data.userId !== uid || data.pinId !== expected.pinId
          || JSON.stringify(data.contentIds) !== JSON.stringify(expected.contentIds)) addError('index_mismatch');
        expectedRows.delete(row.id);
      }
      if (expectedRows.size) addError('missing_index_row');
      if (activate && checkpoint?.phase !== 'complete') addError('backfill_incomplete');
      const report = { uid, dryRun, valid: errors.length === 0, errors, revision, currentPins: pins.length,
        currentVisitedOwnedPins: visitedCount, contributionCount: contributions.length, indexRows: rows.length,
        checkpoint: checkpoint || null, activated: false };
      abortIfNeeded(signal);
      if (activate && !dryRun) {
        if (errors.length) return report;
        txn.set(r.stats, { status: 'ready', validatedRevision: revision, validatedAt: stamp() }, { merge: true });
        txn.set(r.account, { indexReady: true, schemaVersion: SCHEMA, validatedRevision: revision,
          historyCoverageStart: control.historyCoverageStart, activatedAt: stamp() }, { merge: true });
        txn.set(db.collection(`users/${uid}/interestProfile`).doc('baseline'), {
          ...summarizeInterestBaseline(pins, millis(control.historyCoverageStart)),
          historyCoverageStart: control.historyCoverageStart, observedAt: stamp(),
        });
        report.activated = true;
      }
      return report;
    });
  }

  function checkPageSize(size) {
    if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('invalid_page_size');
  }

  async function run({ uid, dryRun = true, pageSize = 100, maxPages = 10, restart = false, signal } = {}) {
    checkUid(uid); checkPageSize(pageSize);
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('invalid_max_pages');
    if (dryRun) return verify({ uid, pageSize, signal });
    const r = refs(uid);
    abortIfNeeded(signal);
    let checkpoint = await db.runTransaction(async txn => {
      const control = dataOf(await txn.get(controlRef));
      const user = await txn.get(r.user), tombstone = await txn.get(r.tombstone);
      const prior = dataOf(await txn.get(r.checkpoint)), stats = await txn.get(r.stats);
      checkActive(control, user, tombstone);
      if (prior && !restart) return prior;
      const next = { phase: 'pins', cursor: null, pages: 0, epoch: (prior?.epoch || 0) + 1 };
      txn.set(r.checkpoint, { ...next, updatedAt: stamp() });
      txn.set(r.account, { indexReady: false }, { merge: true });
      txn.set(r.stats, stats.exists ? { status: 'building' } : { schemaVersion: SCHEMA,
        status: 'building', currentPins: 0, currentVisitedOwnedPins: 0, revision: 0 }, { merge: true });
      return next;
    });
    let processed = 0, pages = 0;
    while (checkpoint.phase !== 'complete' && pages < maxPages) {
      abortIfNeeded(signal);
      const collection = checkpoint.phase === 'pins' ? 'pins' : 'pinContributions';
      let query = db.collection(collection).where('userId', '==', uid).orderBy('__name__').limit(pageSize);
      if (checkpoint.cursor) query = query.startAfter(checkpoint.cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        abortIfNeeded(signal);
        const pinId = checkpoint.phase === 'pins' ? doc.id : doc.data().pinId;
        if (!validId(pinId)) throw new Error('invalid_contribution_identity');
        const result = await reconcile({ uid, pinId });
        if (result.status !== 'reconciled') throw new Error(`reconcile_${result.status}`);
        processed++;
      }
      abortIfNeeded(signal);
      const next = { ...checkpoint, pages: checkpoint.pages + 1,
        ...(page.size < pageSize ? { phase: checkpoint.phase === 'pins' ? 'contributions' : 'complete', cursor: null }
          : { cursor: page.docs[page.docs.length - 1].id }) };
      await db.runTransaction(async txn => {
        const current = dataOf(await txn.get(r.checkpoint));
        const control = dataOf(await txn.get(controlRef));
        const user = await txn.get(r.user), tombstone = await txn.get(r.tombstone);
        checkActive(control, user, tombstone);
        if (current?.epoch !== checkpoint.epoch || current?.pages !== checkpoint.pages || current?.phase !== checkpoint.phase
          || current?.cursor !== checkpoint.cursor) throw new Error('checkpoint_changed');
        txn.set(r.checkpoint, { ...next, updatedAt: stamp() });
      });
      checkpoint = next; pages++;
    }
    return { uid, dryRun: false, processed, pages, checkpoint, complete: checkpoint.phase === 'complete' };
  }
  return { initializeCapture, run, verify };
}
module.exports = { createAccountingMigration };
