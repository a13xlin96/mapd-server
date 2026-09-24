'use strict';

const {createHash, randomUUID} = require('crypto');
const policyHelpers = require('./engineBudgetPolicy');
const {createSpendJournal} = require('./engineBudgetJournal');
const {DEFAULT_POLICY, DEFAULT_PRICES, DEFAULT_MEDIA_PRICES, TOKENS, tokenKeysFor, usageFrom, validatePolicy, validatePrices, priceTokens, ceilingFor} = policyHelpers;

/**
 * SHIPPED CONSTRAINT: OBSERVATION ONLY. No environment flag, policy.mode,
 * emergency stop, or monetary/request cap can enable runtime enforcement.
 *
 * const budget = createEngineBudget({db}); // Firestore Admin, or use default API
 * const h = budget.beginProviderObservation({provider, stage, rateKey,
 *   descriptor: {physicalCallId, model, maxInputTokens, maxImageTokens,
 *     maxOutputTokens, inputBytes, imageTokens, inputTokenOverhead,
 *     cacheEnabled, maxCacheReadTokens, maxCacheWriteTokens},
 *   context: {verifiedUID, userId, serviceIdentity, attemptId, jobId}});
 * void h.markDispatched(); // immediately before ONE physical provider request
 * void h.settle({result, error, dispatched: true});
 * // OR void h.releaseUnsent(); only for work proven not to have been sent.
 *
 * begin is synchronous. All handle methods resolve (never reject) to
 * {id, mode:'observe', recorded:boolean, reason:string|null, state?:string,
 *  durability:'firestore'|'local'|'unconfirmed', pending:boolean}.
 * These are accounting receipts, NEVER dispatch authorization/deduplication.
 * Production must NOT await observation writes. Dispatch time is captured
 * synchronously by markDispatched, before the physical request. Delayed writes
 * and Firestore callback retries cannot move that observation to another day.
 * Each physical retry needs a new id. Stable physicalCallId is server-owned;
 * reuse only to reconcile/replay accounting for the SAME physical request.
 * Followers/cache hits must not create a handle. The producer owns its charge.
 * Only trusted auth/job context may supply verifiedUID/userId/serviceIdentity/
 * attemptId/jobId. NEVER pass a request body as context. Body, uid, accountId,
 * headers, and descriptors cannot assign ownership.
 * Missing identity/rates/storage are diagnostics, never a reason to stop work.
 *
 * Token bounds are inclusive maxima. maxInputTokens excludes images, which
 * have an explicit maxImageTokens (0 for text). inputBytes is a conservative
 * one-token-per-UTF8-byte bound for the COMPLETE serialized text input, plus
 * inputTokenOverhead (default 1024 for framing); imageTokens aliases the image
 * bound, defaulting to 0 for text. Refine these with provider-aware bounds.
 * cacheEnabled:false is a trusted
 * descriptor assertion that this request cannot use prompt caching. Omitted
 * bounds/rates/usage remain unknown. No prompt, image, URL, result body, error
 * message, or raw account/attempt identity is written to the ledger/logs.
 *
 * Daily/lifetime counters exist separately for each accounting dimension.
 * Sum global daily counters for engine spend; NEVER add account/attempt/global
 * rows together. Lifetime minus today's unresolved liability gives prior-day
 * risk (see priorDayRisk). Prepared observations carry no reservation: this
 * release neither reserves spending nor authorizes a future enforcement path.
 *
 * Collection rules must deny client access. Records are not expired here:
 * deleting unresolved records/counters or idempotency keys is unsafe. Provider
 * requests and persistence are not atomic: a process can die before the first
 * async durable write. Never interpret an unconfirmed receipt as queued work.
 * Local receipts survive restart only if the journal volume is retained; use
 * ENGINE_SPEND_OUTBOX_DIR on persistent storage. Render's ephemeral filesystem
 * does NOT preserve local-only observations across host replacement/deploy;
 * those observations can be lost before Firestore acknowledgement. Persisted
 * Firestore pending records do survive replacement and worker restart.
 * Firestore receipts confirm a per-call transition, NOT synchronous counters
 * or exactly-once billing. Start
 * createEngineBudgetWorker separately to recover journals and aggregate totals.
 */
const MODE = 'observe';
const COLLECTIONS = Object.freeze({calls: 'engineSpendCalls', counters: 'engineSpendCounters'});
const PROVIDERS = ['openai', 'anthropic', 'google', 'instagram', 'tiktok', 'youtube', 'extractor', 'other'];
const STAGES = ['media', 'media_download', 'frame_selection', 'transcription', 'video_vision', 'media_fusion', 'source', 'extraction', 'ai', 'vision', 'matching', 'details', 'other'];
const COUNTERS = ['physicalCalls', 'knownActualMicrodollars', 'uncertainLiabilityMicrodollars',
  'unknownLiabilityCalls', 'unresolvedCalls', 'settledCalls'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const usageKeys = version => version === 2 ? [...TOKENS, 'textInput', 'audioInput'] : TOKENS;
const blankUsage = version => Object.fromEntries(usageKeys(version).map(key => [key, null]));
const blankCounters = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
function fail(code) { const error = new Error(code); error.budgetDiagnostic = code; return error; }

function sanitizeDescriptor(raw) {
  raw = object(raw);
  const out = {};
  for (const key of ['maxInputTokens', 'maxImageTokens', 'maxOutputTokens', 'maxCacheReadTokens', 'maxCacheWriteTokens', 'maxTextInputTokens', 'maxAudioInputTokens']) {
    if (integer(raw[key])) out[key] = raw[key];
  }
  if (out.maxInputTokens === undefined && integer(raw.inputBytes)) {
    const overhead = raw.inputTokenOverhead === undefined ? 1024 : raw.inputTokenOverhead;
    if (integer(overhead) && integer(raw.inputBytes + overhead)) out.maxInputTokens = raw.inputBytes + overhead;
  }
  if (out.maxImageTokens === undefined) {
    if (integer(raw.imageTokens)) out.maxImageTokens = raw.imageTokens;
    else if (raw.imageTokens === undefined && !raw.imageCount) out.maxImageTokens = 0;
  }
  if (raw.submittedAudioSeconds === undefined) raw = {...raw, submittedAudioSeconds:raw.audioSeconds};
  if (Number.isFinite(raw.submittedAudioSeconds) && raw.submittedAudioSeconds >= 0 && raw.submittedAudioSeconds <= 86400) out.submittedAudioSeconds = raw.submittedAudioSeconds;
  if (typeof raw.cacheEnabled === 'boolean') out.cacheEnabled = raw.cacheEnabled;
  if (typeof raw.model === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(raw.model)) out.model = raw.model;
  return out;
}

function selectPrice(table, provider, rateKey, descriptor, day) {
  if (!table) return {rate: null, reason: 'invalid_prices'};
  if (day < table.asOf || (table.validThrough && day > table.validThrough)) return {rate: null, reason: 'stale_prices'};
  const rate = Object.hasOwn(table.rates, rateKey) ? table.rates[rateKey] : null;
  if (!rate || rate.provider !== provider) return {rate: null, reason: 'missing_rate'};
  if (descriptor.model && rate.model && rate.model !== descriptor.model) return {rate: null, reason: 'model_mismatch'};
  return {rate: clone(rate), reason: null};
}


function diagnostics(record, code) {
  if (code && !record.diagnostics.includes(code)) record.diagnostics.push(code);
}

function contribution(record) {
  const out = blankCounters();
  if (!record?.dispatchedAt) return out;
  out.physicalCalls = 1;
  out.knownActualMicrodollars = record.knownActualMicrodollars;
  if (record.actualMicrodollars !== null) out.settledCalls = 1;
  else {
    out.unresolvedCalls = 1;
    if (record.ceilingMicrodollars === null || record.ceilingBreached || record.unboundedUsage) out.unknownLiabilityCalls = 1;
    // Known actual + remaining liability never counts the same money twice.
    if (record.ceilingMicrodollars !== null) out.uncertainLiabilityMicrodollars =
      Math.max(0, record.ceilingMicrodollars - record.knownActualMicrodollars);
  }
  return out;
}

function estimateUsage(record) {
  if (!record.rate) return {knownMicrodollars: 0, complete: false};
  if (record.rate.billing === 'calls') return {knownMicrodollars: record.successfulResponse ? record.rate.microdollarsPerCall : 0,
    complete: record.successfulResponse};
  const tokens = {...record.usage};
  if (record.descriptor.cacheEnabled === false) {
    for (const key of ['cacheRead', 'cacheWrite']) if (tokens[key] === null) tokens[key] = 0;
  }
  return priceTokens(tokens, record.rate);
}

function applyEvent(previous, seed, event) {
  if (previous && (![1,2].includes(previous.schemaVersion) || previous.schemaVersion !== seed.schemaVersion || previous.mode !== MODE || previous.fingerprint !== seed.fingerprint)) {
    throw fail('identity_or_schema_conflict');
  }
  const record = clone(previous || seed);
  if (event.type === 'begin') return record;
  if (event.type === 'release') {
    // A late release, HTTP disconnect, lease expiry, or dispatched:false can
    // never refund a dispatch. Only prepared work can become released.
    if (!record.dispatchedAt) { record.state = 'released'; record.releasedAt = event.at; }
    return record;
  }
  if (!event.dispatchedAt) {
    if (!record.dispatchedAt && event.type === 'settle') { record.state = 'released'; record.releasedAt = event.at; }
    return record;
  }
  if (!record.dispatchedAt) {
    if (record.state === 'released') diagnostics(record, 'dispatch_after_release');
    record.dispatchedAt = event.dispatchedAt;
    record.dispatchDay = event.dispatchedAt.slice(0, 10);
    // A pre-midnight prepared record accrues nothing in yesterday's window.
    // Price validity and the day are evaluated at the actual dispatch marker.
    record.rate = seed.rate;
    record.priceVersion = seed.priceVersion;
    record.priceAsOf = seed.priceAsOf;
    record.ceilingMicrodollars = seed.ceilingMicrodollars;
    if (record.schemaVersion === 2) record.durationEstimateMicrodollars = seed.durationEstimateMicrodollars;
    record.diagnostics = [...new Set(record.diagnostics.concat(seed.diagnostics))];
    record.state = 'dispatched';
  }
  if (event.type === 'dispatch') return record;
  if (record.actualMicrodollars !== null) {
    // Final settlements are immutable. Corrections/refunds require a separate
    // audited reconciliation design; this API cannot manufacture credits.
    if (usageKeys(record.schemaVersion).some(key => event.usage[key] != null && record.usage[key] != null && event.usage[key] !== record.usage[key])) {
      diagnostics(record, 'settlement_conflict');
    }
    return record;
  }
  let conflict = false;
  for (const key of usageKeys(record.schemaVersion)) {
    const incoming = event.usage[key] ?? null;
    if (incoming === null) continue;
    if (record.usage[key] !== null && record.usage[key] !== incoming) conflict = true;
    record.usage[key] = Math.max(record.usage[key] ?? 0, incoming);
  }
  if (conflict) diagnostics(record, 'usage_conflict');
  if (['tokens','audio_tokens'].includes(record.rate?.billing)) {
    const limits={input:record.descriptor.maxInputTokens + record.descriptor.maxImageTokens,
      output:record.descriptor.maxOutputTokens,cacheRead:record.descriptor.maxCacheReadTokens,
      cacheWrite:record.descriptor.maxCacheWriteTokens, textInput:record.descriptor.maxTextInputTokens, audioInput:record.descriptor.maxAudioInputTokens};
    for (const key of tokenKeysFor(record.rate)) {
      if (record.usage[key] > 0 && record.rate.microdollarsPerMillion[key] === null) record.unboundedUsage = true;
      if (integer(limits[key]) && record.usage[key] > limits[key]) {
        record.unboundedUsage=true;
        diagnostics(record,'token_bound_exceeded');
      }
    }
    if (record.descriptor.cacheEnabled === false && (record.usage.cacheRead > 0 || record.usage.cacheWrite > 0)) {
      record.unboundedUsage = true;
      diagnostics(record, 'cache_descriptor_mismatch');
    }
  }
  record.successfulResponse ||= event.successfulResponse;
  record.outcome = event.outcome;
  const estimate = estimateUsage(record);
  if (estimate.overflow) {record.unboundedUsage=true;diagnostics(record, 'numeric_overflow');}
  record.knownActualMicrodollars = Math.max(record.knownActualMicrodollars, estimate.knownMicrodollars);
  record.ceilingBreached ||= record.ceilingMicrodollars !== null && record.knownActualMicrodollars > record.ceilingMicrodollars;
  if (record.ceilingBreached) diagnostics(record, 'ceiling_exceeded');
  if (estimate.complete && !record.diagnostics.includes('usage_conflict')) {
    record.actualMicrodollars = record.knownActualMicrodollars;
    record.state = 'settled';
    record.settledAt = event.at;
    record.costSource = record.rate.billing !== 'calls' ? 'reported_usage_at_published_rate' : 'successful_call_at_published_rate';
  } else {
    record.state = 'uncertain';
    diagnostics(record, 'unknown_usage_or_price');
  }
  return record;
}

function counterId(scope, key, window) { return hash(JSON.stringify([scope, key, window])); }
function counterRefs(db, record) {
  const scopes = [['global', 'engine'], ['account', record.owner.key], ['attempt', record.attemptKey]];
  return scopes.flatMap(([scope, key]) => [record.dispatchDay, 'lifetime'].map(window => ({
    ref: db.collection(COLLECTIONS.counters).doc(counterId(scope, key, window)), scope, key, window,
  })));
}

async function persistEvent(db, seed, event) {
  if (!db || typeof db.runTransaction !== 'function') throw fail('ledger_unavailable');
  const ref = db.collection(COLLECTIONS.calls).doc(seed.id);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), previous = snap.exists ? snap.data() : null;
    // Production does not await this telemetry transaction. Its timestamp is
    // the observed physical dispatch boundary, not eventual persistence time.
    const record = applyEvent(previous, seed, event);
    const after = contribution(record);
    record.uncertainLiabilityMicrodollars = after.unknownLiabilityCalls ? null : after.uncertainLiabilityMicrodollars;
    record.unknownLiability = after.unknownLiabilityCalls > 0;
    // Legacy schema-v1 transitions atomically updated counters. Preserve that
    // checkpoint when upgrading one, including already-dispatched records.
    if (!previous || previous.aggregationVersion === undefined) {
      record.aggregationVersion = 1;
      record.aggregatedContribution = contribution(previous);
    } else if (previous.aggregationVersion !== 1) throw fail('identity_or_schema_conflict');
    record.aggregationPending = COUNTERS.some(key => record.aggregatedContribution[key] !== after[key]);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) tx.set(ref, record);
    return {state: record.state, dispatchedAt: record.dispatchedAt, pending: record.aggregationPending};
  }, {maxAttempts: 5});
}

// Only the background worker reads/writes common counters. The checkpoint and
// all six dimensions commit atomically, so retries, lost acknowledgements and
// multiple workers cannot double-count, nor erase a concurrent settlement.
async function aggregateCall(db, id, at = new Date().toISOString()) {
  const ref = db.collection(COLLECTIONS.calls).doc(id);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || !snap.data().aggregationPending) return false;
    const record = snap.data();
    if (![1,2].includes(record.schemaVersion) || record.mode !== MODE || record.aggregationVersion !== 1) throw fail('identity_or_schema_conflict');
    const before = record.aggregatedContribution, after = contribution(record);
    if (!before || COUNTERS.some(key => !integer(before[key]) || !integer(after[key]))) throw fail('counter_corrupt');
    const refs = counterRefs(db, record);
    const snapshots = await Promise.all(refs.map(item => tx.get(item.ref)));
    const updates = refs.map((item, i) => {
      const existing = snapshots[i].exists ? snapshots[i].data() : null;
      if (existing && (existing.schemaVersion !== 1 || existing.mode !== MODE || existing.currency !== 'USD' ||
        existing.scope !== item.scope || existing.key !== item.key || existing.window !== item.window)) {
        throw fail('counter_corrupt');
      }
      // A deleted counter is not evidence of zero past spend; don't apply a
      // refund/delta from an already-dispatched record into a missing counter.
      if (!existing && before.physicalCalls) throw fail('counter_missing');
      const sums = existing || blankCounters();
      const updated = {schemaVersion: 1, mode: MODE, currency: 'USD', scope: item.scope,
        key: item.key, window: item.window, updatedAt: at};
      for (const key of COUNTERS) {
        if (!integer(sums[key])) throw fail('counter_corrupt');
        const next = BigInt(sums[key]) + BigInt(after[key]) - BigInt(before[key]);
        if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('counter_overflow');
        updated[key] = Number(next);
      }
      return updated;
    });
    // All reads precede all writes, including when Firestore retries callback.
    refs.forEach((item, i) => tx.set(item.ref, updates[i]));
    tx.set(ref, {...record, aggregatedContribution: after, aggregationPending: false, aggregatedAt: at});
    return true;
  }, {maxAttempts: 5});
}

function createEngineBudget(options = {}) {
  options = object(options);
  const logger = options.logger === undefined ? console : options.logger;
  const counts = Object.create(null);
  function report(reason, id = null) {
    counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, (counts[reason] || 0) + 1);
    // Static codes and a hashed/random call ID only. Never pass an Error to
    // logging, metrics, or a provider. A broken/async logger must also fail open.
    try {
      const output = logger?.warn?.('engine_budget_observation', {mode: MODE, reason, id});
      if (output && typeof output.then === 'function') Promise.resolve(output).catch(() => {});
    } catch { /* observation must never reject paid work */ }
  }
  let prices = null, policy = DEFAULT_POLICY, priceConfiguration = 'configured', policyConfiguration = 'configured';
  try { prices = validatePrices(options.prices === undefined ? DEFAULT_PRICES : options.prices); }
  catch { priceConfiguration = 'invalid'; report('invalid_prices'); }
  try { policy = validatePolicy(options.policy === undefined ? DEFAULT_POLICY : options.policy); }
  catch { policyConfiguration = 'invalid'; report('invalid_policy'); }
  if (policy.mode !== MODE || policy.emergencyStop || Object.values(policy.limits).some(value => value !== null)) report('enforcement_inactive');
  const timeoutMs = integer(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 5000 ? options.timeoutMs : 250;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  function stamp() {
    try { return new Date(clock()).toISOString(); }
    catch { report('invalid_clock'); return new Date().toISOString(); }
  }
  const getDb = typeof options.getDb === 'function' ? options.getDb : () => options.db;
  const getContext = typeof options.getContext === 'function' ? options.getContext : () => null;
  // journal:null is a deliberate test/embedded configuration with no disk
  // durability. Production defaults to an fsync'd, restart-readable journal.
  const journal = options.journal === null ? null : createSpendJournal({directory: options.journalDirectory});
  const pendingWrites = new Set();
  function track(promise) {
    pendingWrites.add(promise);
    promise.then(() => pendingWrites.delete(promise), () => pendingWrites.delete(promise));
    return promise;
  }
  // Tests/graceful shutdown only, after stopping producers. Unlike a bounded
  // receipt this waits for late SDK commits/cleanup; never await on dispatch.
  async function flushPendingWrites() {
    while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
  }

  function beginProviderObservation(input = {}) {
    let id = randomUUID();
    let seed, descriptor, rateKey, localDispatchAt = null;
    try {
      input = object(input);
      const rawDescriptor = object(input.descriptor);
      if (identity(rawDescriptor.physicalCallId)) id = hash(rawDescriptor.physicalCallId);
      descriptor = sanitizeDescriptor(rawDescriptor);
      const ctx = object(input.context === undefined ? getContext() : input.context);
      const account = identity(ctx.verifiedUID) ? ctx.verifiedUID : identity(ctx.userId) ? ctx.userId : null;
      const service = identity(ctx.serviceIdentity) ? ctx.serviceIdentity : 'engine-unattributed';
      const owner = account ? {kind: 'account', key: hash(`account:${account}`)} :
        {kind: 'service', key: hash(`service:${service}`)};
      const attempt = identity(ctx.attemptId) ? ctx.attemptId :
        identity(ctx.jobId) ? ctx.jobId : id;
      const provider = PROVIDERS.includes(input.provider) ? input.provider : 'other';
      rateKey = typeof input.rateKey === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(input.rateKey) ? input.rateKey : 'unknown';
      const at = stamp();
      seed = {schemaVersion: provider === 'openai' ? 2 : 1, mode: MODE, currency: 'USD', id, owner,
        attemptKey: hash(JSON.stringify([owner.key, attempt])), provider,
        stage: STAGES.includes(input.stage) ? input.stage : 'other',
        rateKey: prices && Object.hasOwn(prices.rates, rateKey) ? rateKey : 'unknown',
        descriptor, createdAt: at, dispatchedAt: null, dispatchDay: null, settledAt: null,
        releasedAt: null, state: 'prepared', policyVersion: policy.version, policyConfiguration,
        priceConfiguration, priceVersion: prices?.version || null, priceAsOf: prices?.asOf || null,
        rate: null, ceilingMicrodollars: null, actualMicrodollars: null, knownActualMicrodollars: 0,
        ceilingBreached: false, unboundedUsage: false, usage: blankUsage(provider === 'openai' ? 2 : 1), successfulResponse: false, outcome: 'unknown', costSource: null, diagnostics: []};
      // Hash unknown rate keys too so two different unknown SKUs cannot alias.
      seed.fingerprint = hash(JSON.stringify([provider, rateKey, owner, seed.attemptKey]));
      if (!account && service === 'engine-unattributed') diagnostics(seed, 'missing_trusted_identity');
      if (attempt === id) diagnostics(seed, 'missing_attempt_identity');
      if (policyConfiguration === 'invalid') diagnostics(seed, 'invalid_policy');
      if (policy.mode !== MODE || policy.emergencyStop || Object.values(policy.limits).some(value => value !== null)) diagnostics(seed, 'enforcement_inactive');
      refreshPrice(at);
    } catch {
      report('invalid_observation', id);
      const noop = async () => ({id, mode: MODE, recorded: false, reason: 'invalid_observation', durability: 'unconfirmed', pending: false});
      return Object.freeze({id, markDispatched: noop, settle: noop, releaseUnsent: noop});
    }
    function refreshPrice(at, target = seed) {
      const table = options.prices === undefined && seed.provider === 'openai' ? DEFAULT_MEDIA_PRICES : prices;
      const {rate, reason} = selectPrice(table, seed.provider, rateKey, descriptor, at.slice(0, 10));
      target.priceVersion = table?.version || null; target.priceAsOf = table?.asOf || null;
      if (seed.provider === 'openai') {
        const estimate = descriptor.submittedAudioSeconds * rate?.estimateMicrodollarsPerMinute / 60;
        target.durationEstimateMicrodollars = Number.isFinite(estimate) && estimate <= Number.MAX_SAFE_INTEGER ? Math.ceil(estimate) : null;
        // Planning estimate, excluded from contribution()/actualMicrodollars.
      }
      target.rate = rate; target.rateKey = rate ? rateKey : 'unknown';
      target.ceilingMicrodollars = ceilingFor(rate, descriptor);
      diagnostics(target, reason);
      if (target.ceilingMicrodollars === null) diagnostics(target, 'unknown_ceiling');
    }
    for (const reason of seed.diagnostics) report(reason, id);

    let queue = Promise.resolve();
    function enqueue(event) {
      const snapshot = clone(seed);
      let durableLocally = false;
      // Journal independently of the per-handle database queue: a hung prepare
      // must not prevent dispatch/settlement from reaching durable local disk.
      const journalWrite = track(journal ? journal.append({seed: snapshot, event}).then(file => {
        durableLocally = true;
        return file;
      }, () => { report('journal_unavailable', id); return null; }) : Promise.resolve(null));
      const run = async () => {
        let timer;
        try {
          // Remote persistence must progress even if append/fsync never ends.
          const work = track(Promise.resolve().then(() => persistEvent(getDb(), snapshot, event)));
          // Remove only this event's completed journal, after remote success.
          // Joining both paths handles either completion order, including a
          // late append after a remote acknowledgement or receipt timeout.
          // Cleanup never delays that acknowledgement; failure leaves a
          // harmless duplicate for recovery. Flush tracks late disk I/O too.
          track(Promise.all([journalWrite, work]).then(async ([file]) => {
            if (file) await journal.remove(file).catch(() => report('journal_cleanup_failure', id));
          }, () => {}));
          const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(fail('ledger_timeout')), timeoutMs);
          });
          const receipt = await Promise.race([work.catch(async error => {
            // On remote failure, allow local fsync to establish durability,
            // but only within this receipt's original bounded deadline.
            await journalWrite;
            throw error;
          }), deadline]);
          if (receipt.dispatchedAt) localDispatchAt = receipt.dispatchedAt;
          return {id, mode: MODE, recorded: true, reason: null, state: receipt.state, durability: 'firestore', pending: receipt.pending};
        } catch (error) {
          const known = ['ledger_unavailable', 'ledger_timeout', 'identity_or_schema_conflict', 'counter_corrupt', 'counter_missing', 'counter_overflow'];
          let reason = 'ledger_failure';
          try { if (known.includes(error?.budgetDiagnostic)) reason = error.budgetDiagnostic; } catch { /* untrusted error */ }
          report(reason, id);
          // A timeout never cancels/discards the transition. Confirm only the
          // durability we actually know, even if a late commit may still land.
          return {id, mode: MODE, recorded: false, reason, durability: durableLocally ? 'local' : 'unconfirmed', pending: durableLocally};
        } finally { clearTimeout(timer); }
      };
      queue = track(queue.then(run, run));
      return queue;
    }
    // Persist prepared records for crash diagnostics, but do not reserve money.
    enqueue({type: 'begin', at: seed.createdAt});
    function safe(work) {
      try { return work(); }
      catch {
        report('invalid_observation', id);
        return Promise.resolve({id, mode: MODE, recorded: false, reason: 'invalid_observation', durability: 'unconfirmed', pending: false});
      }
    }
    function mark() {
      if (!localDispatchAt) { localDispatchAt = stamp(); refreshPrice(localDispatchAt); }
      return localDispatchAt;
    }
    return Object.freeze({id,
      markDispatched() { return safe(() => enqueue({type: 'dispatch', at: stamp(), dispatchedAt: mark()})); },
      settle(args = {}) { return safe(() => {
        args = object(args);
        // Explicit false is honored only if this handle has never dispatched;
        // durable state is authoritative even when a second handle says false.
        const dispatchedAt = localDispatchAt || (args.dispatched !== false ? mark() : null);
        return enqueue({type: 'settle', at: stamp(), dispatchedAt,
          usage: usageFrom(args.result, args.error, seed.provider),
          successfulResponse: !args.error && args.result !== undefined && args.result !== null,
          outcome: args.error ? 'failed' : args.result !== undefined && args.result !== null ? 'success' : 'unknown'});
      }); },
      releaseUnsent() { return safe(() => enqueue({type: 'release', at: stamp()})); },
    });
  }
  return Object.freeze({mode: MODE, beginProviderObservation, flushPendingWrites,
    getDiagnostics: () => ({mode: MODE, counts: {...counts}})});
}

// Importing this module has no datastore/provider side effects. The parent
// already owns Admin initialization and authenticated AsyncLocalStorage context.
let defaultBudget;
function beginProviderObservation(input) {
  try {
    defaultBudget ||= createEngineBudget({db: require('./firestore').firestore,
      getContext: () => require('./jobContext').current()});
    return defaultBudget.beginProviderObservation(input);
  } catch {
    return createEngineBudget({db: null, logger: null}).beginProviderObservation(input);
  }
}
async function flushProviderObservations() { await defaultBudget?.flushPendingWrites(); }

module.exports = {MODE, COLLECTIONS, createEngineBudget, beginProviderObservation, flushProviderObservations, counterId,
  usageFrom, blankCounters, persistEvent, aggregateCall, ...policyHelpers};
