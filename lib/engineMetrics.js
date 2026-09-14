'use strict';

// No logging or storage dependencies. Only the persistence hook receives jobId;
// never put its arguments in logs. All label registries are server configuration.
const {randomUUID} = require('crypto');
const {performance} = require('perf_hooks');
const jobContext = require('./jobContext');
const VERSION = 1;
const PLATFORMS = Object.freeze(['instagram', 'tiktok', 'youtube', 'google_maps', 'web', 'other', 'unknown']);
const LANGUAGES = Object.freeze(['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'hi', 'th', 'vi', 'id', 'ru', 'mixed', 'other', 'unknown']);
const STAGES = ['queue', 'source', 'metadata', 'extraction', 'ai', 'vision', 'matching', 'details', 'save', 'projection', 'delivery', 'other'];
const OUTCOMES = ['success', 'failed', 'partial', 'duplicate', 'no_place', 'confirmation', 'blocked', 'rate_limited', 'timeout', 'cancelled', 'unknown'];
const PROVIDERS = ['anthropic', 'google', 'instagram', 'tiktok', 'youtube', 'redis', 'firestore', 'extractor', 'other'];
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const EVIDENCE = ['title', 'caption', 'hashtags', 'mentions', 'subtitles', 'image', 'location'];
const OPS = ['projectionLagMs', 'projectionMismatches', 'failedDeliveries', 'lookupReads', 'providerRejections', 'cooldownMs'];
const DEFAULT_PRICES = Object.freeze({schemaVersion: 1, asOf: '2026-09-14', currency: 'USD', rates: {}});
const contexts = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
const label = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
function exact(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error(`Invalid ${where}`);
}
function validatePrices(table) {
  exact(table, ['schemaVersion', 'asOf', 'currency', 'rates'], 'price table');
  if (table.schemaVersion !== 1 || table.currency !== 'USD' || !/^\d{4}-\d{2}-\d{2}$/.test(table.asOf) || new Date(table.asOf).toISOString().slice(0, 10) !== table.asOf) throw new Error('Invalid price table date/version/currency');
  exact(table.rates, Object.keys(table.rates || {}), 'rates');
  if (Object.keys(table.rates).length > 64) throw new Error('Too many rate keys');
  for (const [key, rate] of Object.entries(table.rates)) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(key)) throw new Error('Invalid rate key');
    exact(rate, ['provider', 'billing', 'usdPerCall', 'usdPerMillion'], 'rate');
    if (!PROVIDERS.includes(rate.provider) || !['calls', 'tokens'].includes(rate.billing)) throw new Error('Invalid rate provider/billing');
    if (rate.billing === 'calls') {
      if (!finite(rate.usdPerCall) || rate.usdPerMillion !== undefined) throw new Error('Invalid call price');
    } else {
      exact(rate.usdPerMillion, TOKEN_KEYS, 'token prices');
      if (rate.usdPerCall !== undefined || TOKEN_KEYS.some(k => rate.usdPerMillion[k] !== null && !finite(rate.usdPerMillion[k]))) throw new Error('All four token rates must be numbers or explicit null');
    }
  }
  return clone(table);
}
function estimateCall(call, table) {
  const rate = Object.hasOwn(table.rates, call.rateKey) ? table.rates[call.rateKey] : null;
  if (!rate || rate.provider !== call.provider) return {knownUsd: 0, complete: false, reason: 'missing_rate'};
  if (rate.billing === 'calls') {
    if (call.outcome !== 'success') return {knownUsd: 0, complete: false, reason: 'unknown_failed_call_billing'};
    return {knownUsd: rate.usdPerCall, complete: true, reason: null};
  }
  let knownUsd = 0, missing = false;
  for (const key of TOKEN_KEYS) {
    const n = call.tokens[key], price = rate.usdPerMillion[key];
    if (n === null || (price === null && n > 0)) missing = true;
    else if (n > 0) knownUsd += n * price / 1e6;
  }
  if (!Number.isFinite(knownUsd)) return {knownUsd: 0, complete: false, reason: 'numeric_overflow'};
  return {knownUsd, complete: !missing, reason: missing ? 'missing_usage_or_rate' : null};
}

function createMetrics({platform, language, featureVersion, featureVersions = [], prices = DEFAULT_PRICES,
  queueMs = null, processingMissingReason = null, priceConfiguration = 'default', maxEvents = 256, now = () => performance.now(), wallNow = () => new Date()} = {}) {
  const table = validatePrices(prices);
  if (![null, 'not_started', 'not_observed'].includes(processingMissingReason)) throw new Error('Invalid missing duration reason');
  if (!['default', 'configured', 'invalid'].includes(priceConfiguration)) throw new Error('Invalid price configuration status');
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1024) throw new Error('maxEvents must be 1..1024');
  // Caller must supply a bounded, trusted registry, never versions from a request.
  if (!Array.isArray(featureVersions) || featureVersions.length > 64 || featureVersions.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(v))) throw new Error('Invalid server feature registry');
  const start = now();
  const data = {schemaVersion: VERSION, reportId: randomUUID(), startedAt: wallNow().toISOString(),
    platform: label(platform, PLATFORMS), language: label(language, LANGUAGES),
    featureVersion: label(featureVersion, featureVersions), queueMs: finite(queueMs) ? queueMs : null,
    processingMs: null, processingMissingReason, priceConfiguration, outcome: 'unknown', evidence: {}, stages: [], providerCalls: [], cache: {hit: 0, miss: 0, bypass: 0},
    operations: {}, droppedEvents: 0, prices: table, estimatedCost: null};
  let closed = false, events = 0;
  function accept() {
    if (closed) return false;
    if (events >= maxEvents) {data.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, data.droppedEvents + 1); return false;}
    events++; return true;
  }
  const api = {
    language(value) { if (!closed) data.language = label(value, LANGUAGES); },
    recordStage(stage, durationMs, outcome = 'success') {
      if (accept()) data.stages.push({stage: label(stage, STAGES, 'other'), durationMs: finite(durationMs) ? durationMs : null, outcome: label(outcome, OUTCOMES)});
    },
    async stage(stage, work) {
      const began = now();
      try {const result = await work(); api.recordStage(stage, Math.max(0, now() - began), 'success'); return result;}
      catch (error) {
        const outcome = {rate_limited: 'rate_limited', access_blocked: 'blocked', dependency_timeout: 'timeout', attempt_stopped: 'cancelled'}[error?.code] || 'failed';
        api.recordStage(stage, Math.max(0, now() - began), outcome); throw error;
      }
    },
    providerCall({provider, rateKey, stage, outcome, tokens = {}} = {}) {
      if (!accept()) return;
      const safeTokens = Object.fromEntries(TOKEN_KEYS.map(k => [k, count(tokens?.[k]) ? tokens[k] : null]));
      data.providerCalls.push({provider: label(provider, PROVIDERS, 'other'), rateKey: Object.hasOwn(table.rates, rateKey) ? rateKey : 'unknown',
        stage: label(stage, STAGES, 'other'), outcome: label(outcome, OUTCOMES), tokens: safeTokens});
    },
    cache(outcome) {if (accept() && ['hit', 'miss', 'bypass'].includes(outcome)) data.cache[outcome]++;},
    evidence(coverage) {if (!closed) for (const key of EVIDENCE) if (typeof coverage?.[key] === 'boolean') data.evidence[key] = coverage[key];},
    operation(name, value) {if (OPS.includes(name) && finite(value) && accept()) {
      const previous = data.operations[name] || {sum: 0, observations: 0, max: 0};
      if (Number.isFinite(previous.sum + value)) data.operations[name] = {sum: previous.sum + value, observations: previous.observations + 1, max: Math.max(previous.max, value)};
      else data.droppedEvents++;
    }},
    finish(outcome = 'unknown') {
      if (!closed) {
        closed = true; data.processingMs = processingMissingReason ? null : Math.max(0, now() - start); data.outcome = label(outcome, OUTCOMES);
        const estimates = data.providerCalls.map(call => estimateCall(call, table));
        const unknownCalls = estimates.filter(e => !e.complete).length;
        const knownUsd = estimates.reduce((sum, e) => sum + e.knownUsd, 0);
        const complete = processingMissingReason !== 'not_observed' && priceConfiguration !== 'invalid' && unknownCalls === 0 && data.droppedEvents === 0 && Number.isFinite(knownUsd);
        data.estimatedCost = {currency: 'USD', priceDate: table.asOf, knownUsd: Number.isFinite(knownUsd) ? knownUsd : null,
          totalUsd: complete ? knownUsd : null, complete, observedCalls: estimates.length, unknownCalls,
          reasons: [...new Set(estimates.map(e => e.reason).filter(Boolean).concat(data.droppedEvents ? ['dropped_events'] : [], priceConfiguration === 'invalid' ? ['invalid_price_configuration'] : [], processingMissingReason === 'not_observed' ? ['unobserved_processing'] : []))],
          validation: 'estimate_not_reconciled_to_provider_invoice'};
      }
      return clone(data);
    },
  };
  return Object.freeze(api);
}
function start(options) {
  const context = jobContext.current();
  if (!context) throw new Error('Metrics require a jobContext');
  if (contexts.has(context)) throw new Error('Metrics already started in this context');
  const metrics = createMetrics(options); contexts.set(context, metrics); return metrics;
}
function current() {const ctx = jobContext.current(); return ctx ? contexts.get(ctx) : undefined;}
async function persistPrivate(writePrivateReport, outcome) {
  const context = jobContext.current(), metrics = current();
  if (!metrics || !context?.jobId || typeof writePrivateReport !== 'function') throw new Error('Private metrics persistence needs a job context and hook');
  const report = metrics.finish(outcome);
  // The hook must enforce server-only access, retention, and attempt fencing.
  // reportId is an idempotency key; jobId/leaseOwner are routing, not labels.
  await writePrivateReport({jobId: context.jobId, leaseOwner: context.leaseOwner || null, reportId: report.reportId, report});
  return report;
}

function distribution(values, total) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const q = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
  return {observed: sorted.length, missing: total - sorted.length, p50: q(.5), p95: q(.95),
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    uncertainty: 'descriptive_sample_only; nearest_rank_percentiles; no_population_interval'};
}
function ratio(numerator, denominator) {
  if (!count(numerator) || !count(denominator) || numerator > denominator) throw new Error('Invalid ratio');
  if (!denominator) return {numerator, denominator, value: null, ci95Wilson: null};
  const p = numerator / denominator, z2 = 1.96 ** 2, d = 1 + z2 / denominator;
  const mid = (p + z2 / (2 * denominator)) / d;
  const half = 1.96 * Math.sqrt(p * (1 - p) / denominator + z2 / (4 * denominator ** 2)) / d;
  return {numerator, denominator, value: p, ci95Wilson: [Math.max(0, mid - half), Math.min(1, mid + half)]};
}
function summarizeMetrics(reports) {
  if (!Array.isArray(reports)) throw new Error('Expected an array of per-attempt metrics');
  const ids = new Set();
  for (const r of reports) {
    if (r?.schemaVersion !== VERSION || typeof r.reportId !== 'string' || ids.has(r.reportId) || !PLATFORMS.includes(r.platform) || !LANGUAGES.includes(r.language) || !OUTCOMES.includes(r.outcome) || !Array.isArray(r.providerCalls) || !Array.isArray(r.stages) || !r.cache || !count(r.droppedEvents) || !r.operations || !r.evidence || r.providerCalls.length + r.stages.length > 1024) throw new Error('Invalid or duplicate metrics report');
    ids.add(r.reportId);
    if ((r.queueMs !== null && !finite(r.queueMs)) || (r.processingMs !== null && !finite(r.processingMs)) || (r.processingMs === null && !['not_started', 'not_observed'].includes(r.processingMissingReason))) throw new Error('Invalid metric duration');
    validatePrices(r.prices);
    for (const call of r.providerCalls) {
      if (!PROVIDERS.includes(call.provider) || !call.tokens || TOKEN_KEYS.some(k => call.tokens[k] !== null && !count(call.tokens[k]))) throw new Error('Invalid provider usage');
    }
    if (['hit', 'miss', 'bypass'].some(k => !count(r.cache[k]))) throw new Error('Invalid cache counts');
    if (typeof r.startedAt !== 'string' || !Number.isFinite(Date.parse(r.startedAt)) || new Date(r.startedAt).toISOString() !== r.startedAt) throw new Error('Invalid metric timestamp');
    if (r.stages.some(s => !STAGES.includes(s.stage) || !OUTCOMES.includes(s.outcome) || (s.durationMs !== null && !finite(s.durationMs)))) throw new Error('Invalid stage samples');
    for (const [key, op] of Object.entries(r.operations)) if (!OPS.includes(key) || !finite(op.sum) || !finite(op.max) || !count(op.observations) || !op.observations) throw new Error('Invalid operational samples');
    for (const [key, value] of Object.entries(r.evidence)) if (!EVIDENCE.includes(key) || typeof value !== 'boolean') throw new Error('Invalid evidence coverage');
  }
  function aggregate(rows) {
    const calls = rows.flatMap(r => r.providerCalls.map(c => estimateCall(c, r.prices)));
    const knownUsd = calls.reduce((s, c) => s + c.knownUsd, 0);
    const completeAttempts = rows.filter(r => r.processingMissingReason !== 'not_observed' && r.priceConfiguration !== 'invalid' && !r.droppedEvents && r.providerCalls.every(c => estimateCall(c, r.prices).complete)).length;
    const complete = completeAttempts === rows.length && rows.length > 0;
    const cache = {hit: 0, miss: 0, bypass: 0};
    for (const r of rows) for (const k of Object.keys(cache)) cache[k] += r.cache[k];
    const stages = rows.flatMap(r => r.stages), providerCalls = rows.flatMap(r => r.providerCalls);
    return {attempts: rows.length, queueMs: distribution(rows.map(r => r.queueMs), rows.length), processingMs: distribution(rows.map(r => r.processingMs), rows.length),
      outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length])),
      partialRate: ratio(rows.filter(r => r.outcome === 'partial').length, rows.length),
      confirmationRate: ratio(rows.filter(r => r.outcome === 'confirmation').length, rows.length),
      terminalBlockedAttemptRate: ratio(rows.filter(r => ['blocked', 'rate_limited'].includes(r.outcome)).length, rows.length),
      blockedSourceRate: ratio(rows.filter(r => r.stages.some(s => s.stage === 'source' && ['blocked', 'rate_limited'].includes(s.outcome))).length,
        rows.filter(r => r.stages.some(s => s.stage === 'source')).length),
      cache: {...cache, hitRate: ratio(cache.hit, cache.hit + cache.miss), savingsUsd: null, savingsReason: 'counterfactual_provider_work_not_measured'},
      cost: {currency: 'USD', knownUsd, totalUsd: complete ? knownUsd : null, completeAttempts, unknownAttempts: rows.length - completeAttempts,
        observedProviderCalls: calls.length, unknownCalls: calls.filter(c => !c.complete).length,
        perAttemptUsd: complete ? knownUsd / rows.length : null, attemptedLinksDenominator: null,
        perAttemptedLinkUsd: null, correctlySavedNewPlacesDenominator: null, perCorrectlySavedNewPlaceUsd: null,
        limitation: 'attempts_may_include_retries; link_and_correct_save_denominators_require_labeled_evaluation', priceDates: [...new Set(rows.map(r => r.prices.asOf))].sort()},
      stages: Object.fromEntries(STAGES.map(stage => {
        const samples = stages.filter(s => s.stage === stage);
        return [stage, {durationMs: distribution(samples.map(s => s.durationMs), samples.length),
          outcomes: Object.fromEntries(OUTCOMES.map(o => [o, samples.filter(s => s.outcome === o).length]))}];
      })),
      providers: Object.fromEntries(PROVIDERS.map(provider => {
        const samples = providerCalls.filter(c => c.provider === provider);
        return [provider, {calls: samples.length, tokens: Object.fromEntries(TOKEN_KEYS.map(key => [key, {
          known: samples.reduce((s, c) => s + (c.tokens[key] ?? 0), 0), observedCalls: samples.filter(c => c.tokens[key] !== null).length,
          unknownCalls: samples.filter(c => c.tokens[key] === null).length}]))}];
      })),
      evidence: Object.fromEntries(EVIDENCE.map(key => [key, ratio(rows.filter(r => r.evidence[key] === true).length, rows.filter(r => typeof r.evidence[key] === 'boolean').length)])),
      operations: Object.fromEntries(OPS.map(key => {
        const samples = rows.map(r => r.operations[key]).filter(Boolean), observations = samples.reduce((s, v) => s + v.observations, 0);
        const sum = samples.reduce((s, v) => s + v.sum, 0);
        return [key, {sum: observations ? sum : null, observations, mean: observations ? sum / observations : null, max: samples.length ? Math.max(...samples.map(v => v.max)) : null}];
      })),
      droppedEvents: rows.reduce((s, r) => s + r.droppedEvents, 0)};
  }
  const group = key => Object.fromEntries([...new Set(reports.map(r => r[key]))].sort().map(value => [value, aggregate(reports.filter(r => r[key] === value))]));
  return {schemaVersion: VERSION, scope: 'operational_attempt_metrics_not_measured_accuracy', generatedAt: new Date().toISOString(),
    overall: aggregate(reports), byPlatform: group('platform'), byLanguage: group('language'),
    byDate: Object.fromEntries([...new Set(reports.map(r => r.startedAt.slice(0, 10)))].sort().map(day => [day, aggregate(reports.filter(r => r.startedAt.startsWith(day)))])),
    quality: null, releaseGate: {ready: false, reasons: ['independently_verified_real_corpus_and_baseline_required']},
    limitations: ['Stage durations may overlap; processing duration is wall time.', 'Uninstrumented provider calls cannot be detected; complete cost means observed calls only.', 'Price estimates require reconciliation against provider usage.', 'Outcome rates describe terminal attempt outcomes, not independent labeled source/quality judgments.']};
}
function compareAggregates(currentReport, baselineReport) {
  const a = currentReport.overall, b = baselineReport.overall;
  const values = [
    ['processingP50Ms', a.processingMs.p50, b.processingMs.p50], ['processingP95Ms', a.processingMs.p95, b.processingMs.p95],
    ['queueP50Ms', a.queueMs.p50, b.queueMs.p50], ['queueP95Ms', a.queueMs.p95, b.queueMs.p95],
    [Object.hasOwn(a.cost, 'perAttemptUsd') ? 'costPerAttemptUsd' : 'costPerAttemptedLinkUsd',
      Object.hasOwn(a.cost, 'perAttemptUsd') ? a.cost.perAttemptUsd : a.cost.perAttemptedLinkUsd,
      Object.hasOwn(b.cost, 'perAttemptUsd') ? b.cost.perAttemptUsd : b.cost.perAttemptedLinkUsd],
    ['costPerCorrectlySavedNewPlaceUsd', a.cost.perCorrectlySavedNewPlaceUsd, b.cost.perCorrectlySavedNewPlaceUsd],
  ];
  const changes = values.map(([metric, currentValue, baselineValue]) => {
    const available = finite(currentValue) && finite(baselineValue);
    const relativeChange = available && baselineValue > 0 ? (currentValue - baselineValue) / baselineValue : null;
    const exceeds = relativeChange !== null ? Math.abs(relativeChange) >= .1 - 1e-12 : available && baselineValue === 0 && currentValue > 0;
    return {metric, current: currentValue ?? null, baseline: baselineValue ?? null, relativeChange,
      status: !available ? 'unavailable' : baselineValue === 0 ? 'zero_baseline' : 'compared',
      changeAtLeast10Percent: exceeds, investigationRequired: exceeds && currentValue > baselineValue};
  });
  return {baselineSamples: b.attempts ?? b.attemptedLinks, currentSamples: a.attempts ?? a.attemptedLinks, changes,
    priceDatesMatch: JSON.stringify(a.cost.priceDates) === JSON.stringify(b.cost.priceDates),
    investigationRequired: changes.some(c => c.investigationRequired), limitation: 'Descriptive comparison, not causal or statistically significant; compare like cohorts and price dates.'};
}
module.exports = {VERSION, PLATFORMS, LANGUAGES, DEFAULT_PRICES, validatePrices, createMetrics, start, current, persistPrivate,
  distribution, ratio, summarizeMetrics, compareAggregates};
