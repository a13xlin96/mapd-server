const { hash, validId, identities, indexRows } = require('./contentIdentity');
const { createPinMetadataAccounting } = require('./pinMetadataAccounting');
const SCHEMA = 2;
const millis = value => typeof value?.toMillis === 'function' ? value.toMillis()
  : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN;
const clean = (value, max = 128) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const dataOf = snapshot => snapshot?.exists ? snapshot.data() : null;
const generationOf = snapshot => Number.isFinite(snapshot?.createTime?.seconds)
  ? `${snapshot.createTime.seconds}:${snapshot.createTime.nanoseconds}`
  : Number.isFinite(millis(snapshot?.createTime)) ? String(millis(snapshot.createTime)) : null;
const counter = (value, delta) => Math.max(0, (Number.isFinite(value) ? value : 0) + delta);

function refsFor(db, uid, pinId) {
  return {
    user: db.collection('users').doc(uid),
    tombstone: db.collection('accountingTombstones').doc(uid),
    stats: db.collection(`users/${uid}/stats`).doc('current'),
    profile: db.collection(`users/${uid}/interestProfile`).doc('v2'),
    contribution: db.collection('pinContributions').doc(hash(`${uid}\0${pinId}`)),
    pin: db.collection('pins').doc(pinId),
  };
}

function eventFacts(change, time) {
  const before = dataOf(change?.before), after = dataOf(change?.after);
  if (!before && !after) return [];
  const pin = after || before;
  const facts = { category: clean(pin.category, 64) || 'other', city: clean(pin.city),
    country: clean(pin.country), placeId: clean(pin.placeId, 200),
    metadataProvenance: 'saved_pin', occurredAtMs: time };
  if (!before) return [{ type: 'pin_created', ...facts }];
  if (!after) return [{ type: 'pin_deleted', ...facts }];
  const prior = new Set(identities(before));
  const added = identities(after).filter(key => !prior.has(key));
  return [
    ...(added.length ? [{ type: 'source_added', sourceKeys: added, count: added.length, ...facts }] : []),
    ...((before.visited === true) !== (after.visited === true) ? [{ type: after.visited === true ? 'visit_marked' : 'visit_unmarked', provenance: 'legacy_pin', ...facts }] : []),
  ];
}

function committedMutation({ uid, pinId, change, eventId, eventTime }) {
  const pin = dataOf(change?.after) || dataOf(change?.before);
  if (!eventId || !pin || pin.userId !== uid) return null;
  const time = change?.after?.exists ? millis(change.after.updateTime)
    : typeof eventTime === 'string' ? Date.parse(eventTime) : millis(eventTime);
  const snapshot = change?.after?.exists ? change.after : change?.before;
  const generation = generationOf(snapshot);
  const mutationId = !change?.before?.exists ? 'created' : !change?.after?.exists ? 'deleted'
    : generationOf({ createTime: change.after.updateTime }) || eventId;
  if (!generation || !Number.isFinite(time)) throw new Error('missing_committed_event_metadata');
  return { uid, pinId, generation, mutationId, eventTime: time, createdAt: millis(snapshot.createTime),
    tripSignalId: clean(pin.tripSignalIdAtSave, 200), facts: eventFacts(change, time) };
}

const receiptIdFor = item => hash(`${item.uid}\0${item.pinId}\0${item.generation}\0${item.mutationId}`);

/** Current contributions read the latest pin, while immutable history uses
 * the committed trigger snapshots. Do not turn a backfill into save history.
 * All reads precede writes, and receipt + profile updates share one commit.
 */
function createPinAccounting({ db, admin, now = Date.now }) {
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const timestamp = ms => admin.firestore.Timestamp.fromMillis(ms);
  const metadata = createPinMetadataAccounting({ db, admin });

  async function reconcile({ uid, pinId, change = null, eventId = null, eventTime = null, committedEvent = null }) {
    if (!validId(uid) || !validId(pinId)) throw new Error('invalid_accounting_identity');
    const refs = refsFor(db, uid, pinId);
    return db.runTransaction(async txn => {
      const control = dataOf(await txn.get(db.collection('accountingControls').doc('current')));
      const cutover = millis(control?.historyCoverageStart);
      if (control?.captureEnabled !== true || !Number.isFinite(cutover)) return { status: 'disabled' };
      const user = await txn.get(refs.user), tombstone = await txn.get(refs.tombstone);
      if (!user.exists || (tombstone.exists && (!tombstone.data().deletedGeneration || tombstone.data().deletedGeneration === generationOf(user)))) return { status: 'inactive_account' };
      const current = await txn.get(refs.pin), priorSnap = await txn.get(refs.contribution);
      const ownVisit = await txn.get(db.collection(`pins/${pinId}/visits`).doc(uid));
      const statsSnap = await txn.get(refs.stats), profileSnap = await txn.get(refs.profile);
      const prior = dataOf(priorSnap), stats = dataOf(statsSnap) || {}, profile = dataOf(profileSnap) || {};
      const pin = current.exists && current.data().userId === uid ? current.data() : null;
      if (prior && prior.userId !== uid) throw new Error('invalid_contribution_owner');
      if (!pin && !prior && !change && !committedEvent) return { status: 'not_owned' };
      const keys = identities(pin), rows = indexRows(uid, pinId, keys);
      const exists = !!pin;
      const generation = exists ? generationOf(current) : null;
      if (exists && !generation) throw new Error('missing_pin_generation');
      const validVisit = exists && ownVisit.exists && ownVisit.data().userId === uid
        && millis(ownVisit.updateTime) >= millis(current.createTime);
      const visited = exists && (validVisit ? ownVisit.data().visited === true : pin.visited === true);
      const digest = hash(JSON.stringify({ exists, generation, visited, keys }));
      const changed = prior?.digest !== digest;

      // committedEvent is loaded exclusively from the server-only inbox;
      // HTTP bodies and client-created records never enter this interface.
      const mutation = committedEvent || committedMutation({ uid, pinId, change, eventId, eventTime });
      const eventMs = mutation?.eventTime, eventGeneration = mutation?.generation;
      const isEvent = mutation?.uid === uid && mutation.pinId === pinId && !!eventGeneration && Number.isFinite(eventMs)
        && eventMs >= cutover;
      const receiptRef = isEvent ? db.collection('pinMutationReceipts').doc(receiptIdFor(mutation)) : null;
      const receipt = receiptRef ? await txn.get(receiptRef) : null;
      // An old create delivered after cutover is baseline, not a new save.
      const facts = isEvent && !receipt.exists ? mutation.facts.filter(fact =>
        (fact.type !== 'pin_created' || mutation.createdAt >= cutover)
        && !(fact.provenance === 'legacy_pin' && validVisit)) : [];
      const freshSave = facts.find(fact => fact.type === 'pin_created');
      const sourceAdds = facts.filter(fact => fact.type === 'source_added').reduce((n, fact) => n + fact.count, 0);
      const signalId = mutation?.tripSignalId;
      const signal = freshSave && validId(signalId) ? await txn.get(db.collection('tripSignals').doc(signalId)) : null;
      const tripRef = signal?.exists && signal.data().userId === uid
        ? db.collection(`users/${uid}/tripSaveStats`).doc(hash(signalId)) : null;
      const tripStats = tripRef ? dataOf(await txn.get(tripRef)) || {} : null;
      const newer = freshSave && eventMs > (profile.lastPinSavedAtMs ?? -1);
      const latestSave = newer ? { lastPinId: pinId, lastPinGeneration: eventGeneration,
        lastPinSavedAtMs: eventMs, lastPinCategory: freshSave.category,
        lastPinCity: freshSave.city, lastPinCountry: freshSave.country } : {};
      const projection = await metadata.prepare({ txn, uid, pinId, pin, generation,
        accountGeneration: generationOf(user), priorContribution: prior, profile: { ...profile, ...latestSave } });

      if (changed) {
        const nextIds = new Set(rows.map(row => row.id));
        for (const id of prior?.indexRowIds || []) if (!nextIds.has(id)) txn.delete(db.collection('pinContentIndex').doc(id));
        for (const row of rows) txn.set(db.collection('pinContentIndex').doc(row.id), row);
        txn.set(refs.contribution, { userId: uid, pinId, schemaVersion: SCHEMA, exists, visited, generation,
          digest, indexRowIds: [...nextIds], metadataGeneration: exists ? generation : null, updatedAt: stamp() });
        txn.set(refs.stats, { schemaVersion: SCHEMA, status: stats.status || 'building',
          currentPins: counter(stats.currentPins, Number(exists) - Number(prior?.exists === true)),
          currentVisitedOwnedPins: counter(stats.currentVisitedOwnedPins, Number(visited) - Number(prior?.visited === true)),
          revision: (stats.revision || 0) + 1, updatedAt: stamp() }, { merge: true });
      }
      if (!changed && projection.changed) txn.set(refs.contribution,
        { metadataGeneration: exists ? generation : null }, { merge: true });
      projection.apply();
      if (receiptRef && !receipt.exists) {
        const eventRefs = facts.map((fact, i) => ({ ref: db.collection(`users/${uid}/saveEvents`).doc(hash(`${receiptRef.id}\0${i}`)), fact }));
        txn.set(receiptRef, { userId: uid, pinId, generation: eventGeneration, eventTime: timestamp(eventMs),
          effectCount: facts.length, schemaVersion: SCHEMA, recordedAt: stamp() });
        for (const { ref, fact } of eventRefs) txn.set(ref, { ...fact, userId: uid, pinId, schemaVersion: SCHEMA, recordedAt: stamp() });
      }
      if (freshSave || sourceAdds || Object.keys(projection.profilePatch).length) {
        txn.set(refs.profile, { schemaVersion: SCHEMA, historyCoverageStart: timestamp(cutover),
          verifiedPinSaves: counter(profile.verifiedPinSaves, freshSave ? 1 : 0),
          sourceAdditions: counter(profile.sourceAdditions, sourceAdds), updatedAt: stamp(),
          ...latestSave, ...projection.profilePatch }, { merge: true });
      }
      if (tripRef) txn.set(tripRef, { schemaVersion: SCHEMA, tripSignalId: signalId,
        verifiedPinSaves: counter(tripStats.verifiedPinSaves, 1),
        categories: [...new Set([...(tripStats.categories || []), freshSave.category])],
        lastSaveAtMs: Math.max(tripStats.lastSaveAtMs || 0, eventMs), updatedAt: stamp() }, { merge: true });
      return { status: 'reconciled', changed, metadataChanged: projection.changed, effects: facts.length };
    });
  }

  async function onPinWritten(event) {
    const change = event.data;
    const before = dataOf(change?.before), after = dataOf(change?.after);
    const uid = (after || before)?.userId;
    if (!validId(uid) || !validId(event.params?.pinId)) return { status: 'invalid_event' };
    if (before && after && before.userId !== after.userId) throw new Error('pin_owner_changed');
    const result = await capture(committedMutation({ uid, pinId: event.params.pinId, change, eventId: event.id, eventTime: event.time }));
    // Even a previously acknowledged event may arrive after another metadata
    // write. Reconcile the DB's latest state without replaying historical facts.
    return result.status === 'complete' ? reconcile({ uid, pinId: event.params.pinId }) : result;
  }

  async function capture(mutation) {
    if (!mutation) return { status: 'invalid_event' };
    const id = receiptIdFor(mutation), inbox = db.collection('accountingInbox').doc(id);
    const admitted = await db.runTransaction(async txn => {
      const control = dataOf(await txn.get(db.collection('accountingControls').doc('current')));
      const previous = await txn.get(inbox);
      if (previous.exists) return true;
      if (control?.captureEnabled !== true || !Number.isFinite(millis(control.historyCoverageStart))) return false;
      // Persist minimal committed facts before acknowledging the trigger. A
      // crash or exhausted retries leaves a repairable record, not lost history.
      // Large source updates can fit a pin yet expand past 1 MiB when hashed.
      // Keep the manifest small; canonical source identities live in chunks.
      const facts = mutation.facts.map(fact => {
        if (!fact.sourceKeys) return fact;
        for (let offset = 0; offset < fact.sourceKeys.length; offset += 500) {
          txn.set(db.collection(`accountingInbox/${id}/sources`).doc(String(offset / 500)), { keys: fact.sourceKeys.slice(offset, offset + 500) });
        }
        const { sourceKeys, ...summary } = fact;
        return { ...summary, sourceManifestId: id, sourceChunks: Math.ceil(sourceKeys.length / 500) };
      });
      txn.set(inbox, { userId: mutation.uid, mutation: { ...mutation, facts }, state: 'pending', attempts: 0, recordedAt: stamp() });
      return true;
    });
    return admitted ? repairMutation(id) : { status: 'disabled' };
  }

  async function repairMutation(id, { manual = false } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_receipt_id');
    const inbox = db.collection('accountingInbox').doc(id), item = dataOf(await inbox.get());
    if (!item || item.state === 'complete' || (item.state === 'needs_review' && !manual)) return { status: item?.state || 'missing' };
    try {
      const result = await reconcile({ uid: item.mutation.uid, pinId: item.mutation.pinId, committedEvent: item.mutation });
      if (result.status === 'inactive_account') await inbox.update({ state: 'awaiting_account', updatedAt: stamp() });
      else if (result.status !== 'disabled') await inbox.update({ state: 'complete', completedAt: stamp() });
      return result;
    } catch (error) {
      const attempts = await db.runTransaction(async txn => {
        const latest = dataOf(await txn.get(inbox));
        if (latest?.state === 'complete') return 0;
        const n = (latest?.attempts || 0) + 1;
        txn.update(inbox, { attempts: n, state: n >= 20 ? 'needs_review' : 'pending',
          lastError: 'projection_failed', updatedAt: stamp() });
        return n;
      });
      if (attempts >= 20) return { status: 'needs_review' };
      throw error;
    }
  }

  async function onUserDeleted(event) {
    const uid = event.params?.userId;
    if (!validId(uid) || !event.data?.exists) return;
    // Written independently of client-editable user fields; delayed pin events
    // cannot recreate any account data after deletion or an offline replay.
    await db.runTransaction(async txn => {
      const current = await txn.get(db.collection('users').doc(uid));
      const deletedGeneration = generationOf(event.data);
      if (current.exists && generationOf(current) !== deletedGeneration) return;
      txn.set(db.collection('accountingTombstones').doc(uid), { deletedGeneration, deletedAt: stamp(), schemaVersion: SCHEMA });
    });
  }

  async function onVisitWritten(event) {
    const uid = event.params?.userId, pinId = event.params?.pinId;
    if (!validId(uid) || !validId(pinId)) return { status: 'invalid_event' };
    // Preserve the visitor's committed assertion even if the pin was later
    // removed/reused by another owner. Reconciliation separately counts only
    // current owned pins; visit history is not an ownership claim.
    const before = dataOf(event.data?.before), after = dataOf(event.data?.after);
    if (event.id && (before || after)) {
      const item = committedMutation({ uid, pinId, change: event.data, eventId: event.id, eventTime: event.time });
      const changed = (before?.visited === true) !== (after?.visited === true);
      if (item) {
        item.mutationId = `visit:${item.mutationId}`;
        item.tripSignalId = null;
        item.facts = changed ? [{ type: after?.visited === true ? 'visit_marked' : 'visit_unmarked', provenance: 'visit_document', occurredAtMs: item.eventTime }] : [];
        return capture(item);
      }
    }
    return reconcile({ uid, pinId });
  }

  return { reconcile, onPinWritten, onUserDeleted, onVisitWritten, repairMutation, refsFor: (uid, pinId) => refsFor(db, uid, pinId) };
}

module.exports = { createPinAccounting, refsFor, eventFacts, generationOf, millis, SCHEMA };
