'use strict';
const {randomUUID} = require('crypto');
const {EngineError} = require('./engineError');
const {isMediaOperation} = require('./media/mediaContext');
const COLLECTION = 'engineSharedAiOperations';
// Server-owned, client-denied. Missing document means no emergency stop;
// malformed present configuration fails closed for NEW media dispatch only.
const MEDIA_CONTROL = Object.freeze({collection:'engineControl', document:'mediaExecution'});
const mediaStopped = control => !!control && (control.schemaVersion !== 1 || control.stopNewMediaDispatch !== false);
const stopped = () => new EngineError('attempt_stopped', {stage:'coordination'});
const uncertain = record => ({code:'dependency_timeout', stage:'coordination', provider:record?.provider || 'engine'});

// Heads fence dispatch/publication; immutable generation identities let existing
// followers read their own outcome even after an explicit refresh has started.
function createSharedAiStore({firestore, now = Date.now, retentionMs = 7 * 86400000}) {
  const ref = id => firestore.collection(COLLECTION).doc(id);
  const expiry = () => new Date(now() + retentionMs);
  async function transaction(work) {
    try { return await firestore.runTransaction(work); }
    catch (cause) {
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('dependency_error', {stage:'coordination', provider:'firestore', cause});
    }
  }
  function subscribers(record, subscription) {
    const live = Object.fromEntries(Object.entries(record.subscribers || {}).filter(([,until]) => Number.isFinite(until) && until > now()));
    if (subscription) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(subscription.id || '')) throw stopped();
      // Evaluate inside the transaction, including retries: a local cancellation
      // while reads were pending must not re-register the departing subscriber.
      const requested = typeof subscription.expiresAt === 'function' ? subscription.expiresAt() : subscription.expiresAt;
      const until = Math.min(requested || 0, record.deadline, now() + 120000);
      delete live[subscription.id];
      if (Number.isFinite(until) && until > now()) live[subscription.id] = until;
    }
    if (Object.keys(live).length > 256) throw new EngineError('queue_full', {stage:'coordination'});
    return live;
  }
  async function claim({key, refresh, refreshAfter, retryGeneration, subscription, leaseMs, timeoutMs, provider = 'engine', kind = null, owner = randomUUID()}) {
    if (kind !== null && (typeof kind !== 'string' || kind.length > 128)) throw stopped();
    if (retryGeneration !== undefined) {
      if (!Number.isSafeInteger(retryGeneration) || retryGeneration < 1) throw stopped();
      refresh = true;
      refreshAfter = retryGeneration;
    }
    return transaction(async tx => {
      const head = (await tx.get(ref(key))).data();
      const previousRef = head ? ref(`${key}_${head.generation}`) : null;
      let previous = previousRef ? (await tx.get(previousRef)).data() : null;
      const anchorRef = refreshAfter == null ? null : ref(`${key}_${refreshAfter}`);
      let anchor = anchorRef ? (refreshAfter === head?.generation ? previous : (await tx.get(anchorRef)).data()) : null;
      if (retryGeneration !== undefined && (!head || !anchor || !['failed','uncertain'].includes(anchor.state))) throw stopped();
      if (anchorRef && !anchor) throw new EngineError('dependency_error', {stage:'coordination'});
      // A refresh already waiting behind a normal generation has ONE successor,
      // independent of the latest head or how long its watcher was suspended.
      const successorGeneration = retryGeneration !== undefined ? anchor?.retrySuccessor : anchor?.refreshSuccessor;
      if (successorGeneration) {
        const successorRef = ref(`${key}_${successorGeneration}`);
        const successor = (await tx.get(successorRef)).data();
        if (!successor) throw new EngineError('dependency_error', {stage:'coordination'});
        if (successor.state === 'running' && subscription) {
          tx.set(successorRef, {...successor, subscribers:subscribers(successor, subscription)});
        }
        return {leader:false, record:successor};
      }
      // Only the failed head can acquire a new successor. A stale or forged
      // token without its own recorded successor never grants fresh spending.
      if (retryGeneration !== undefined && head.generation !== retryGeneration) throw stopped();
      // All reads precede writes, including an expired predecessor and anchor.
      if (head && !previous && !refresh) throw new EngineError('dependency_error', {stage:'coordination'});
      let normalPredecessor = previous;
      if (previous?.state === 'running' && previous.leaseUntil <= now()) {
        if (previous.dispatch) {
          previous = {...previous, state:'uncertain', failure:uncertain(previous), expireAt:expiry()};
          tx.set(previousRef, previous);
          normalPredecessor = previous;
        } else {
          normalPredecessor = {...previous, state:'failed', failure:{code:'attempt_stopped', stage:'coordination', provider:'engine'}, expireAt:expiry()};
          tx.set(previousRef, normalPredecessor);
          previous = null;
        }
        if (anchor?.generation === normalPredecessor.generation) anchor = normalPredecessor;
      }
      if (previous?.state === 'running') {
        const waitForPrevious = refresh && !previous.refresh;
        // Waiting to refresh does not itself demand another OLD paid response.
        if (!waitForPrevious && subscription) {
          previous = {...previous, subscribers:subscribers(previous, subscription)};
          tx.set(previousRef, previous);
        }
        if (anchorRef && previous.refresh) tx.set(anchorRef, {...anchor, refreshSuccessor:previous.generation});
        return {leader:false, record:previous, waitForPrevious};
      }
      const expiredUnsentFailure = previous?.state === 'failed' && !previous.dispatch && previous.failureUntil <= now();
      if (previous && !refresh && !expiredUnsentFailure && (previous.state !== 'complete' || previous.resultUntil > now())) {
        return {leader:false, record:previous};
      }
      const generation = (head?.generation || 0) + 1;
      const record = {generation, owner, provider, kind, state:'running', refresh:!!refresh,
        startedAt:now(), deadline:now() + timeoutMs, leaseUntil:now() + Math.min(leaseMs, timeoutMs),
        dispatch:null, expireAt:expiry()};
      record.subscribers = subscribers(record, subscription);
      if (anchorRef) tx.set(anchorRef, {...anchor, [retryGeneration === undefined ? 'refreshSuccessor' : 'retrySuccessor']:generation});
      // Also link a refresh whose initial claim followed a just-completed normal
      // generation, so earlier slow waiters can discover this same successor.
      if (retryGeneration === undefined && refresh && normalPredecessor && !normalPredecessor.refresh && previousRef && refreshAfter !== normalPredecessor.generation) {
        tx.set(previousRef, {...normalPredecessor, refreshSuccessor:generation});
      }
      tx.set(ref(key), {generation, expireAt:expiry()});
      tx.set(ref(`${key}_${generation}`), record);
      return {leader:true, record};
    });
  }
  async function updateSubscription(key, record, subscription, validationId) {
    return transaction(async tx => {
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      if (!current || current.state !== 'running') return;
      const updated = subscribers(current, subscription);
      const validations = Object.fromEntries(Object.entries(current.subscriberValidations || {}).filter(([id]) => updated[id]));
      delete validations[subscription.id];
      const validatedUntil = Math.min(updated[subscription.id] || 0, subscription.validatedUntil?.(validationId) || 0);
      if (validatedUntil > now() && validationId && validationId === current.dispatchCheck?.id) {
        validations[subscription.id] = {id:validationId, until:validatedUntil,
          deadline:Math.min(current.deadline, subscription.validatedDeadline?.(validationId) || validatedUntil)};
      }
      if (JSON.stringify(updated) !== JSON.stringify(current.subscribers || {}) ||
        JSON.stringify(validations) !== JSON.stringify(current.subscriberValidations || {})) {
        tx.set(genRef, {...current, subscribers:updated, subscriberValidations:validations});
      }
    });
  }
  async function read(key, generation) {
    try {
      const record = (await ref(`${key}_${generation}`).get()).data();
      if (!record) throw new Error('Missing shared generation');
      return record;
    } catch (cause) { throw new EngineError('dependency_error', {stage:'coordination', provider:'firestore', cause}); }
  }
  async function headGeneration(key) {
    try {
      const generation = (await ref(key).get()).data()?.generation;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Missing shared head');
      return generation;
    } catch (cause) { throw new EngineError('dependency_error', {stage:'coordination', provider:'firestore', cause}); }
  }
  function watch(key, record, deadline) {
    const genRef = ref(`${key}_${record.generation}`);
    if (typeof genRef.onSnapshot !== 'function') return null; // Synthetic datastore.
    return new Promise((resolve, reject) => {
      let unsubscribe, timer, settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); unsubscribe?.();
        if (error) reject(error); else resolve(value);
      }
      function schedule() {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // Release the watcher before a potentially unavailable transaction.
          unsubscribe?.(); unsubscribe = null;
          if (deadline <= now()) finish(new EngineError('dependency_timeout', {stage:'coordination'}));
          else expire(key, record).then(value => finish(null, value), finish);
        }, Math.max(1, Math.min(record.leaseUntil, deadline) - now()));
      }
      schedule();
      try {
        unsubscribe = genRef.onSnapshot(snapshot => {
          if (settled) return;
          const data = snapshot.data();
          if (!data) return finish(new EngineError('dependency_error', {stage:'coordination',provider:'firestore'}));
          record = data;
          if (data.state !== 'running') finish(null, data); else schedule();
        }, cause => finish(new EngineError('dependency_error', {stage:'coordination',provider:'firestore',cause})));
        if (settled) unsubscribe?.();
      } catch (cause) { finish(new EngineError('dependency_error', {stage:'coordination',provider:'firestore',cause})); }
    });
  }
  async function beginDispatchCheck(key, record) {
    const id = randomUUID();
    return transaction(async tx => {
      const head = (await tx.get(ref(key))).data();
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      if (head?.generation !== record.generation || current?.owner !== record.owner || current.state !== 'running' ||
        current.dispatch || current.leaseUntil <= now() || current.deadline <= now()) throw stopped();
      tx.set(genRef, {...current, dispatchCheck:{id}, subscriberValidations:{}});
      return id;
    });
  }
  function validatedSubscribers(current, live, validationId) {
    if (!validationId) return live; // Legacy store callers do not use challenges.
    if (current.dispatchCheck?.id !== validationId) throw stopped();
    return Object.fromEntries(Object.entries(live).flatMap(([id, until]) => {
      const validation = current.subscriberValidations?.[id];
      return validation?.id === validationId && validation.until > now() ? [[id, Math.min(until, validation.until)]] : [];
    }));
  }
  async function authorizeDispatch(key, record, {reservationId = null, subscription, validationId} = {}) {
    if (reservationId !== null && (typeof reservationId !== 'string' || reservationId.length > 200)) throw stopped();
    const dispatchId = randomUUID(); // Stable across Firestore transaction retries.
    return transaction(async tx => {
      const head = (await tx.get(ref(key))).data();
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      // This read shares the dispatch-marker transaction, establishing the
      // live stop's ordering boundary. A stop committed later cannot retract
      // a marker already committed, nor gate publication/completed saves.
      if (isMediaOperation(current?.kind)) {
        const control = (await tx.get(firestore.collection(MEDIA_CONTROL.collection).doc(MEDIA_CONTROL.document))).data();
        if (mediaStopped(control)) throw stopped();
      }
      if (head?.generation !== record.generation || current?.owner !== record.owner ||
        current.state !== 'running' || current.dispatch || current.leaseUntil <= now() || current.deadline <= now()) throw stopped();
      const live = subscribers(current, subscription);
      if (!Object.keys(live).length) throw stopped();
      if (!Object.keys(validatedSubscribers(current, live, validationId || current.dispatchCheck?.id)).length) return null;
      const dispatch = {id:dispatchId, reservationId, at:now(),
        ...(isMediaOperation(current.kind) ? {demandUntil:Math.max(...Object.keys(validatedSubscribers(current, live, validationId || current.dispatchCheck?.id))
          .map(id => current.subscriberValidations?.[id]?.deadline || live[id]))} : {})};
      tx.set(genRef, {...current, subscribers:live, dispatch, leaseUntil:current.deadline});
      return dispatch;
    });
  }
  /** Read-only, server-owned stop hint for an already authorized media send.
   * This does not grant dispatch authority or remove a committed marker.
   * The caller must bound this read and keep failures distinct from a stop. */
  async function mediaDispatchStopped() {
    try {
      return mediaStopped((await firestore.collection(MEDIA_CONTROL.collection).doc(MEDIA_CONTROL.document).get()).data());
    } catch (cause) {
      throw new EngineError('dependency_error', {stage:'coordination', provider:'firestore', cause});
    }
  }
  async function remoteDispatchDemandUntil(key, record, dispatch, subscription) {
    return transaction(async tx => {
      const head = (await tx.get(ref(key))).data();
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      if (head?.generation !== record.generation || current?.owner !== record.owner ||
        current.state !== 'running' || current.dispatch?.id !== dispatch.id ||
        current.leaseUntil <= now() || current.deadline <= now()) throw stopped();
      const live = validatedSubscribers(current, subscribers(current, subscription), current.dispatchCheck?.id);
      tx.set(genRef, {...current, subscribers:live});
      // Never let an acknowledged snapshot of our OWN membership substitute
      // for the process's current cancellation state after the await.
      return Math.max(0, ...Object.entries(live).filter(([id]) => id !== subscription.id).map(([id,until]) =>
        isMediaOperation(current.kind) ? Math.min(current.deadline, current.subscriberValidations?.[id]?.deadline || until) : until));
    });
  }
  async function publish(key, record, {result, ttlMs, failure}) {
    return transaction(async tx => {
      const head = (await tx.get(ref(key))).data();
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      if (head?.generation !== record.generation || current?.owner !== record.owner || current.state !== 'running') throw stopped();
      if (current.deadline <= now() || current.leaseUntil <= now()) {
        tx.set(genRef, {...current, state:current.dispatch ? 'uncertain' : 'failed', failure:uncertain(current), failureUntil:now(), expireAt:expiry()});
        return false;
      }
      if (failure) tx.set(genRef, {...current, state:'failed', failure, failureUntil:now() + (failure.code === 'attempt_stopped' && !current.dispatch ? 0 : 5000), expireAt:expiry()});
      else tx.set(genRef, {...current, state:'complete', result, resultUntil:now() + ttlMs, expireAt:expiry()});
      return true;
    });
  }
  async function expire(key, record) {
    return transaction(async tx => {
      const genRef = ref(`${key}_${record.generation}`);
      const current = (await tx.get(genRef)).data();
      if (current?.owner === record.owner && current.state === 'running' && current.leaseUntil <= now()) {
        const expired = {...current, state:current.dispatch ? 'uncertain' : 'failed', failure:uncertain(current), failureUntil:now(), expireAt:expiry()};
        tx.set(genRef, expired);
        return expired;
      }
      return current;
    });
  }
  return {claim, read, headGeneration, watch, updateSubscription, beginDispatchCheck, authorizeDispatch, mediaDispatchStopped, remoteDispatchDemandUntil, publish, expire};
}
module.exports = {createSharedAiStore, COLLECTION, MEDIA_CONTROL};
