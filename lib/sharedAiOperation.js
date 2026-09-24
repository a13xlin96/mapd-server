'use strict';
const {randomUUID} = require('crypto');
const jobContext = require('./jobContext');
const {EngineError, asEngineError} = require('./engineError');
const {identity, SERVER_PUBLIC_SCOPE} = require('./sharedAiIdentity');
const {createSharedAiStore} = require('./sharedAiStore');
const {isMediaOperation} = require('./media/mediaContext');
const metrics = require('./engineMetrics');
const timeout = () => new EngineError('dependency_timeout', {stage:'coordination'});
const stopped = () => new EngineError('attempt_stopped', {stage:'coordination'});
const clone = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MEDIA_STOP_RECHECK_MS = 500;
function bounded(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => finish(reject, stopped());
    const timer = setTimeout(() => finish(reject, timeout()), Math.max(0, ms));
    function finish(fn, value) { clearTimeout(timer); signal?.removeEventListener('abort', cancel); fn(value); }
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function errorContext(options) { return {stage:options.stage || 'ai', provider:options.provider || 'anthropic'}; }
function safeFailure(error, options) {
  const e = asEngineError(error, errorContext(options));
  return {code:e.code, stage:e.stage, provider:e.provider,
    ...(e.retryAfterSeconds == null ? {} : {retryAfterSeconds:e.retryAfterSeconds})};
}
function createSharedAiOperations({firestore, cache, now = Date.now, allowLocal = false, limits = {}} = {}) {
  const maxOperations = Math.min(256, limits.maxOperations || 128);
  const maxFollowers = Math.min(256, limits.maxFollowers || 128);
  const pollMs = Math.max(5, limits.pollMs || 250);
  const active = new Map(), observations = new Map();
  const subscriptionLeaseMs = Math.min(10000, Math.max(50, limits.subscriptionLeaseMs || 5000));
  const store = firestore?.runTransaction && firestore?.collection ? createSharedAiStore({firestore, now}) : null;
  const stats = {leaders:0, followers:0, cacheHits:0, reads:0};
  // Reuse belongs to each subscribing call, not the producer's paid usage.
  // A local follower can also join a remotely running generation: count that
  // coalescing only once, including when the remote decision arrives later.
  function callerReuse(waiter, name) {
    if (waiter.mediaReuse.has(name)) return;
    waiter.mediaReuse.add(name);
    waiter.metrics?.operation?.(name, 1);
  }
  function mediaReuse(entry, name) {
    if (!entry.media) return;
    entry.mediaReuse.add(name);
    for (const waiter of entry.waiters.values()) callerReuse(waiter, name);
  }
  function valid(value, options) {
    try {
      if (value == null || Buffer.byteLength(JSON.stringify(value)) > Math.min(options.maxResultBytes || 65536, 65536) || options.validate(value) !== true) throw new Error('Invalid result');
      return clone(value);
    } catch (cause) { throw new EngineError('invalid_response', {...errorContext(options), cause}); }
  }
  async function cached(key, options) {
    if (!cache?.getCached) return null;
    try {
      const result = await bounded(cache.getCached(key), 2000);
      if (result == null) return null;
      return valid(result, options);
    } catch { return null; } // Durable ownership is independent of result-cache availability.
  }
  async function callerActive(caller, signal) {
    if (signal?.aborted || caller?.signal?.aborted) throw stopped();
    if (Number.isFinite(caller?.deadline) && caller.deadline <= now()) throw timeout();
    await bounded(jobContext.run(caller, async () => {
      await jobContext.assertActive();
      // Repeatable authority only; beforeProviderDispatch is a one-shot mark.
      await caller?.validateProviderDispatch?.();
    }),
      Math.min(5000, Number.isFinite(caller?.deadline) ? Math.max(0, caller.deadline - now()) : 5000), signal);
    if (signal?.aborted || caller?.signal?.aborted) throw stopped();
  }
  async function watchGeneration(key, record, deadline) {
    while (record.state === 'running') {
      if (now() >= deadline) throw timeout();
      if (record.leaseUntil <= now()) return store.expire(key, record);
      const subscription = store.watch(key, record, deadline);
      if (subscription) {record = await subscription; continue;}
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      stats.reads++;
      record = await store.read(key, record.generation);
    }
    return record;
  }
  function observe(key, record, deadline) {
    const watchKey = `${key}:${record.generation}`;
    if (!observations.has(watchKey)) {
      observations.set(watchKey, watchGeneration(key, record, deadline).finally(() => observations.delete(watchKey)));
    }
    return observations.get(watchKey);
  }
  function outcome(record, options) {
    if (record.state === 'complete') return valid(record.result, options);
    const error = new EngineError(record.failure?.code || 'dependency_error', record.failure || {stage:'coordination'});
    if (['failed','uncertain'].includes(record.state)) error.retryGeneration = record.generation;
    throw error;
  }
  function subscriptionExpiry(entry, validationId) {
    if (entry.done) return 0;
    let until = 0;
    for (const waiter of entry.waiters.values()) {
      if (!waiter.invalid && !waiter.signal?.aborted && !waiter.caller?.signal?.aborted && waiter.until > now()) {
        const expiry = validationId ? (waiter.validationId === validationId ? Math.min(waiter.until, waiter.validatedUntil) : 0) : waiter.until;
        until = Math.max(until, expiry);
      }
    }
    return Math.min(until, now() + subscriptionLeaseMs);
  }
  function subscriptionDeadline(entry, validationId) {
    if (entry.done) return 0;
    return Math.max(0, ...[...entry.waiters.values()].filter(w => !w.invalid &&
      !w.signal?.aborted && !w.caller?.signal?.aborted && w.until > now() &&
      (!validationId || (w.validationId === validationId && w.validatedUntil > now()))).map(w => w.until));
  }
  async function validateWaiters(entry, validationId) {
    await Promise.all([...entry.waiters.values()].map(async waiter => {
      if (waiter.invalid || entry.done) return;
      try {
        await callerActive(waiter.caller, waiter.signal);
        waiter.validationId = validationId;
        waiter.validatedUntil = now() + subscriptionLeaseMs;
      }
      catch (error) { waiter.invalid = error; }
    }));
  }
  function retire(entry) {
    entry.done = true;
    clearTimeout(entry.timer);
    if (active.get(entry.mapKey) === entry) active.delete(entry.mapKey);
  }
  function syncSubscription(entry) {
    // Serialized, but evaluate membership when the transaction runs, not when
    // queued. A delayed heartbeat may never restore a cancelled membership.
    const update = async () => {
      if (store) for (const record of entry.records.values()) {
        const current = await store.read(entry.key, record.generation);
        if (current.state !== 'running') continue;
        // A nonce is read BEFORE validation. Only a response to this dispatch's
        // challenge counts; a prior lease/heartbeat is never caller authority.
        await validateWaiters(entry, current.dispatchCheck?.id);
        await store.updateSubscription(entry.key, record, entry.subscription, current.dispatchCheck?.id);
      }
    };
    entry.subscriptionQueue = entry.subscriptionQueue.then(update, update);
    return entry.subscriptionQueue;
  }
  function renewSubscription(entry) {
    if (entry.timer || entry.done || !subscriptionExpiry(entry) || !entry.records.size || !store) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      syncSubscription(entry).catch(() => {}).finally(() => renewSubscription(entry));
    }, Math.max(10, Math.floor(subscriptionLeaseMs / 3)));
  }
  async function attachSubscription(entry, record) {
    if (!store || record.state !== 'running') return;
    entry.records.set(record.generation, record);
    // Also cleans up a cancellation that raced the initial claim's commit.
    await syncSubscription(entry);
    renewSubscription(entry);
  }
  async function execute(id, options, work, caller, entry) {
    const timeoutMs = Math.min(120000, Math.max(1, options.timeoutMs || 45000));
    const deadline = now() + timeoutMs;
    let cacheKey = `engine:shared-ai:v1:${id.key}`;
    const readCache = () => !options.bypassCache && options.retryGeneration === undefined && id.cacheable ? cached(cacheKey, options) : null;
    // Durable generations are authoritative. A late Redis write from an old
    // generation must never overwrite a refresh's result or revive a failure.
    const hit = store ? null : await readCache();
    if (hit !== null) {stats.cacheHits++; mediaReuse(entry, 'mediaCacheHits'); return hit;}
    if (!store && (!allowLocal || process.env.NODE_ENV === 'production')) {
      throw new EngineError('dependency_error', {stage:'coordination', provider:'firestore'});
    }
    if (!store && options.retryGeneration !== undefined) throw stopped();
    let claim, refreshAfter;
    do {
      if (!subscriptionExpiry(entry)) throw stopped();
      claim = store ? await store.claim({key:id.key, refresh:!!options.bypassCache, refreshAfter, retryGeneration:options.retryGeneration, subscription:entry.subscription,
        leaseMs:Math.min(options.leaseMs || timeoutMs, timeoutMs), timeoutMs:Math.max(1, deadline - now()),
        provider:errorContext(options).provider, kind:options.kind}) :
        {leader:true, record:{generation:1, owner:randomUUID(), deadline, leaseUntil:deadline}};
      if (claim.waitForPrevious) refreshAfter ??= claim.record.generation;
      else {
        entry.resolveGeneration(claim.record.generation);
        await attachSubscription(entry, claim.record);
      }
      if (!claim.leader) {
        stats.followers++;
        if (!claim.waitForPrevious && claim.record.state === 'running') mediaReuse(entry, 'mediaCoalesced');
        const record = await observe(id.key, claim.record, deadline);
        if (!claim.waitForPrevious) {
          const result = outcome(record, options);
          if (claim.record.state === 'complete') mediaReuse(entry, 'mediaCacheHits');
          return result;
        }
      }
    } while (!claim.leader && now() < deadline);
    if (!claim.leader || now() >= deadline) throw timeout();
    stats.leaders++;
    const record = claim.record;
    if (store) cacheKey += `:${record.generation}`;
    const controller = new AbortController();
    let dispatched = false, finished = false, publicationAttempted = false, dispatchTimer, mediaRemoteDemandUntil = 0;
    const boundMediaDispatch = until => {
      if (until <= now()) throw stopped();
      context.deadline = Math.min(context.deadline, until);
      dispatchTimer = setTimeout(() => controller.abort(), Math.max(0, context.deadline - now()));
    };
    const sharedOperation = {
      id:id.key, generation:record.generation, owner:record.owner, kind:options.kind,
      async authorizeDispatch({reservationId = null} = {}) {
        if (finished || dispatched || now() >= record.deadline || controller.signal.aborted) throw stopped();
        if (store) {
          const validationId = await store.beginDispatchCheck(id.key, record);
          await syncSubscription(entry);
          let authorization;
          do {
            authorization = await store.authorizeDispatch(id.key, record, {reservationId, subscription:entry.subscription, validationId});
            if (!authorization) await sleep(Math.min(pollMs, Math.max(1, record.deadline - now())));
          } while (!authorization && !finished && now() < record.deadline && !controller.signal.aborted);
          // The transaction may finish after the execution timeout. Never send.
          if (!authorization || finished || now() >= record.deadline || controller.signal.aborted) throw stopped();
          await validateWaiters(entry, validationId);
          if (finished || now() >= record.deadline || controller.signal.aborted) throw stopped();
          if (!subscriptionExpiry(entry, validationId)) {
            // Cancellation can arrive after the dispatch transaction commits
            // but before its acknowledgement. Re-read remote demand; stale
            // local membership in that transaction is not permission to send.
            const remoteUntil = await store.remoteDispatchDemandUntil(id.key, record, authorization, entry.subscription);
            if (finished || now() >= record.deadline || controller.signal.aborted ||
              (!subscriptionExpiry(entry, validationId) && remoteUntil <= now())) throw stopped();
          }
          // Dispatch authority comes from current local demand or the last
          // fenced remote-demand read. The final best-effort stop check below
          // preserves this marker and rechecks known local cancellation;
          // remote cancellation still has an unavoidable send-time window.
          if (isMediaOperation(options.kind)) {
            // Bound the request by demand that authorized it, not the initial
            // caller. Remote followers can outlive the initiating child.
            const remoteUntil = await store.remoteDispatchDemandUntil(id.key, record, authorization, entry.subscription);
            if (finished || controller.signal.aborted) throw stopped();
            mediaRemoteDemandUntil = remoteUntil;
            boundMediaDispatch(Math.max(subscriptionDeadline(entry, validationId), remoteUntil));
          }
          dispatched = true;
          return authorization;
        }
        await validateWaiters(entry);
        if (finished || now() >= record.deadline || controller.signal.aborted || !subscriptionExpiry(entry)) throw stopped();
        if (isMediaOperation(options.kind)) boundMediaDispatch(subscriptionDeadline(entry));
        dispatched = true;
        return {id:randomUUID(), reservationId, at:now()};
      },
      /** Best-effort last stop read before invocation, only after a committed
       * marker. Failure/timeout retains that authorization; a known stop
       * cancels this send without clearing its fence or authorizing a retry.
       * The read is Firestore-backed in production, never Redis authority. */
      async recheckMediaDispatch() {
        if (!isMediaOperation(options.kind)) return;
        const live = () => !finished && dispatched && !controller.signal.aborted && now() < context.deadline &&
          (subscriptionExpiry(entry) > now() || mediaRemoteDemandUntil > now());
        if (!live()) throw stopped();
        let stop = false;
        if (store) {
          try {
            stop = await bounded(store.mediaDispatchStopped(),
              Math.min(MEDIA_STOP_RECHECK_MS, Math.max(0, context.deadline - now())), controller.signal);
          } catch { /* Unknown stop state cannot retract the known committed marker. */ }
        }
        if (stop || !live()) throw stopped();
      },
    };
    // Explicit attribution allowlist: no initiating lease, abort signal, or
    // caller deadline grants authority to shared execution.
    const context = {deadline:record.deadline, signal:controller.signal, sharedOperation,
      sharedMetrics:require('./engineMetrics').current() || caller?.sharedMetrics};
    for (const key of ['verifiedUID','userId','uid','authUid','billingUserId','billingUid','serviceIdentity','serviceId','attemptId','billing','billingContext']) {
      if (caller?.[key] !== undefined) context[key] = caller[key];
    }
    if (caller?.jobId) { context.originatingJobId = caller.jobId; context.attemptId ||= caller.jobId; }
    try {
      // Another producer may have populated the ordinary cache before claim.
      const rechecked = await readCache();
      if (rechecked !== null) mediaReuse(entry, 'mediaCacheHits');
      const result = valid(rechecked ?? await bounded(jobContext.run(context, () => work({signal:controller.signal, deadline:record.deadline, sharedOperation})),
        Math.max(0, record.deadline - now()), controller.signal), options);
      finished = true;
      const seconds = typeof options.ttlSeconds === 'function' ? options.ttlSeconds(result) : options.ttlSeconds || 86400;
      const ttlSeconds = Math.min(86400, Math.max(1, Number.isFinite(seconds) ? seconds : 300));
      publicationAttempted = true;
      if (store && !await store.publish(id.key, record, {result, ttlMs:ttlSeconds * 1000})) throw timeout();
      // Existing waiters retain their promise; new callers must consult the
      // durable head, including a refresh that finishes during this cache I/O.
      if (store) retire(entry);
      if (id.cacheable && cache?.setCache) {
        // Cache failures cannot change a durably published success to failure.
        try { await bounded(cache.setCache(cacheKey, result, ttlSeconds), 2000); } catch { /* durable result remains */ }
      }
      return result;
    } catch (error) {
      finished = true;
      controller.abort();
      if (store && !publicationAttempted) await store.publish(id.key, record, {failure:safeFailure(error, options)});
      if (store) retire(entry);
      const failure = asEngineError(error, errorContext(options));
      if (store) {
        const published = await store.read(id.key, record.generation);
        if (['failed','uncertain'].includes(published.state)) failure.retryGeneration = record.generation;
      }
      throw failure;
    } finally { finished = true; clearTimeout(dispatchTimer); controller.abort(); }
  }
  async function runSharedAiOperation(options, work) {
    if (typeof options?.validate !== 'function' || typeof work !== 'function') throw new EngineError('invalid_response', {stage:'input'});
    if (options.retryGeneration !== undefined && (!Number.isSafeInteger(options.retryGeneration) || options.retryGeneration < 1)) {
      throw new EngineError('invalid_response', {stage:'input'});
    }
    const caller = jobContext.current();
    const callerMetrics = metrics.current();
    const signal = options.signal || caller?.signal;
    await callerActive(caller, signal);
    const id = identity(options);
    const mapKey = `${id.key}:${options.retryGeneration !== undefined ? `refresh:${options.retryGeneration}` : options.bypassCache ? 'refresh' : 'normal'}`;
    let entry = active.get(mapKey);
    const admissionDeadline = now() + Math.min(120000, options.waitMs || 60000,
      Number.isFinite(caller?.deadline) ? Math.max(0, caller.deadline - now()) : Infinity);
    // A follower's completion notification can lag a refresh in another
    // process. New ordinary callers must join the current durable generation;
    // existing waiters keep their original promise and subscription.
    while (entry && store && !options.bypassCache && options.retryGeneration === undefined) {
      const generation = await bounded(entry.generationReady, Math.max(0, admissionDeadline - now()), signal);
      const head = generation == null ? null : await bounded(store.headGeneration(id.key),
        Math.max(0, admissionDeadline - now()), signal);
      if (active.get(mapKey) !== entry) { entry = active.get(mapKey); continue; }
      if (generation == null || head !== generation) { active.delete(mapKey); entry = null; }
      break;
    }
    const joined = !!entry;
    if (!entry) {
      if (active.size >= maxOperations) throw new EngineError('queue_full', {stage:'coordination'});
      entry = {key:id.key, mapKey, followers:0, waiters:new Map(), records:new Map(), subscriptionQueue:Promise.resolve(), done:false,
        media:isMediaOperation(options.kind), mediaReuse:new Set()};
      entry.generationReady = new Promise(resolve => { entry.resolveGeneration = resolve; });
      entry.subscription = {id:randomUUID(), expiresAt:() => subscriptionExpiry(entry),
        validatedUntil:validationId => subscriptionExpiry(entry, validationId),
        validatedDeadline:validationId => subscriptionDeadline(entry, validationId)};
      active.set(mapKey, entry);
      entry.promise = bounded(Promise.resolve().then(() => execute(id, options, work, caller, entry)),
        Math.min(120000, options.timeoutMs || 45000) + 5000).finally(async () => {
          entry.resolveGeneration(null);
          retire(entry);
          try { await bounded(syncSubscription(entry), 2000); } catch { /* expiring membership; never dispatch authority */ }
        });
      // Cancellation may win while the caller is still registering membership.
      // Keep the detached producer's later failure observed even with no waiters.
      entry.promise.catch(() => {});
    }
    if (entry.followers >= maxFollowers) throw new EngineError('queue_full', {stage:'coordination'});
    entry.followers++;
    const waitMs = Math.min(120000, options.waitMs || 60000,
      Number.isFinite(caller?.deadline) ? Math.max(0, caller.deadline - now()) : Infinity);
    const waiterId = randomUUID();
    const waiter = {until:now() + waitMs, signal, caller, metrics:callerMetrics, mediaReuse:new Set()};
    entry.waiters.set(waiterId, waiter);
    if (entry.media && joined) callerReuse(waiter, 'mediaCoalesced');
    for (const name of entry.mediaReuse) callerReuse(waiter, name);
    try {
      await bounded(syncSubscription(entry), Math.min(2000, waitMs), signal);
      renewSubscription(entry);
      const result = await bounded(entry.promise, waitMs, signal);
      await callerActive(caller, signal);
      return valid(result, options);
    } finally {
      entry.followers--; entry.waiters.delete(waiterId);
      if (!entry.waiters.size) {clearTimeout(entry.timer); entry.timer = null;}
      try { await bounded(syncSubscription(entry), 2000); } catch { /* lease expiry bounds a failed release; preserve the caller's outcome */ }
    }
  }
  return {runSharedAiOperation, stats, activeCount:() => active.size};
}
let defaultOperations;
function runSharedAiOperation(options, work) {
  if (!defaultOperations) defaultOperations = createSharedAiOperations({firestore:require('./firestore').firestore,
    cache:require('./cache'), allowLocal:['test','development'].includes(process.env.NODE_ENV) || process.env.ENGINE_SHARED_AI_LOCAL === 'true'});
  return defaultOperations.runSharedAiOperation(options, work);
}
module.exports = {runSharedAiOperation, createSharedAiOperations, SERVER_PUBLIC_SCOPE};
