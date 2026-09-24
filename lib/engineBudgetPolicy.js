'use strict';

// Pure configuration/forecast helpers. Nothing here dispatches, reserves, or
// enables enforcement. engineBudget.js always ships in observation mode.
const TOKENS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const AUDIO_TOKENS = Object.freeze(['textInput', 'audioInput', 'output']);
const tokenKeysFor = rate => rate?.billing === 'audio_tokens' ? AUDIO_TOKENS : TOKENS;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const clone = value => JSON.parse(JSON.stringify(value));
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid budget schema');
}
function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return Object.freeze(value);
}
const DEFAULT_POLICY = freeze({schemaVersion: 1, version: 'observe-only-2026-09-18', mode: 'observe',
  emergencyStop: false, limits: {attemptCalls: null, attemptMicrodollars: null,
    accountDayMicrodollars: null, globalDayMicrodollars: null}});

// Audit-supplied list rates, not invoice reconciliation. $1/$5 per million
// input/output tokens, $0.032 search, $0.025 rich details. Unverified cache
// rates remain null; they must never silently become zero.
const DEFAULT_PRICES = freeze({schemaVersion: 1, version: 'audit-2026-09-18', asOf: '2026-09-18',
  validThrough: null, currency: 'USD', rates: {
    haiku: {provider: 'anthropic', billing: 'tokens', model: 'claude-haiku-4-5-20251001',
      microdollarsPerMillion: {input: 1000000, output: 5000000, cacheRead: null, cacheWrite: null}},
    places_search: {provider: 'google', billing: 'calls', microdollarsPerCall: 32000},
    places_details: {provider: 'google', billing: 'calls', microdollarsPerCall: 25000},
  }});

// v1 remains readable and unchanged for existing Anthropic/Places journals.
// Audio pricing uses separate dimensions even when published unit rates agree.
// Verified 2026-09-21: developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
const DEFAULT_MEDIA_PRICES = freeze({...DEFAULT_PRICES, schemaVersion:2,
  version:'media-2026-09-21', asOf:'2026-09-21', rates:{...DEFAULT_PRICES.rates,
    openai_mini_transcribe:{provider:'openai', billing:'audio_tokens',
      model:'gpt-4o-mini-transcribe-2025-12-15',
      microdollarsPerMillion:{textInput:1250000, audioInput:1250000, output:5000000},
      estimateMicrodollarsPerMinute:3000},
  }});

/** Normalizes physical provider usage only; never infer missing usage from duration. */
function usageFrom(result, error, provider) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const usage = object(result?.usage || error?.usage || error?.response?.data?.usage);
  const names = {input:'input_tokens', output:'output_tokens', cacheRead:'cache_read_input_tokens', cacheWrite:'cache_creation_input_tokens'};
  const out = Object.fromEntries(TOKENS.map(key => [key, integer(usage[names[key]]) ? usage[names[key]] : null]));
  if (provider === 'openai') {
    const details = object(usage.input_token_details || usage.input_tokens_details);
    out.textInput = integer(details.text_tokens) ? details.text_tokens : null;
    out.audioInput = integer(details.audio_tokens) ? details.audio_tokens : null;
    // A contradictory breakdown must not be priced as complete or silently
    // repaired using an aggregate charged at the cheaper text rate.
    if (out.input !== null && out.textInput !== null && out.audioInput !== null &&
      out.input !== out.textInput + out.audioInput) {out.textInput=null;out.audioInput=null;}
  }
  return out;
}

function validatePolicy(policy) {
  exact(policy, ['schemaVersion', 'version', 'mode', 'emergencyStop', 'limits']);
  if (policy.schemaVersion !== 1 || !identifier(policy.version) ||
      !['observe', 'enforce'].includes(policy.mode) || typeof policy.emergencyStop !== 'boolean') {
    throw new Error('Invalid budget policy');
  }
  const keys = Object.keys(DEFAULT_POLICY.limits);
  exact(policy.limits, keys);
  if (keys.some(key => policy.limits[key] !== null && !integer(policy.limits[key]))) {
    throw new Error('Limits must be integer microdollars/calls or explicit null');
  }
  return clone(policy);
}
function validatePrices(prices) {
  exact(prices, ['schemaVersion', 'version', 'asOf', 'validThrough', 'currency', 'rates']);
  if (![1,2].includes(prices.schemaVersion) || !identifier(prices.version) || prices.currency !== 'USD' ||
      !validDay(prices.asOf) || (prices.validThrough !== null &&
        (!validDay(prices.validThrough) || prices.validThrough < prices.asOf))) throw new Error('Invalid budget prices');
  exact(prices.rates, Object.keys(prices.rates || {}));
  if (Object.keys(prices.rates).length > 64) throw new Error('Too many budget rates');
  for (const [key, rate] of Object.entries(prices.rates)) {
    if (!identifier(key)) throw new Error('Invalid rate key');
    exact(rate, ['provider', 'billing', 'model', 'microdollarsPerMillion', 'microdollarsPerCall', ...(prices.schemaVersion === 2 ? ['estimateMicrodollarsPerMinute'] : [])]);
    if (!identifier(rate.provider) || !['calls', 'tokens', ...(prices.schemaVersion === 2 ? ['audio_tokens'] : [])].includes(rate.billing) ||
        (rate.model !== undefined && !identifier(rate.model))) throw new Error('Invalid rate');
    if (rate.billing === 'calls') {
      if (!integer(rate.microdollarsPerCall) || rate.microdollarsPerMillion !== undefined) throw new Error('Invalid call rate');
    } else {
      const keys = tokenKeysFor(rate);
      exact(rate.microdollarsPerMillion, keys);
      if (rate.microdollarsPerCall !== undefined || keys.some(key =>
        rate.microdollarsPerMillion[key] !== null && !integer(rate.microdollarsPerMillion[key]))) throw new Error('Invalid token rate');
    }
    if (rate.estimateMicrodollarsPerMinute !== undefined && (rate.billing !== 'audio_tokens' ||
      !integer(rate.estimateMicrodollarsPerMinute))) throw new Error('Invalid duration estimate');
  }
  return clone(prices);
}

function priceTokens(tokens, rate) {
  let numerator = 0n, complete = true;
  for (const key of tokenKeysFor(rate)) {
    const n = tokens[key], price = rate.microdollarsPerMillion[key];
    if (!integer(n) || (n > 0 && !integer(price))) complete = false;
    else if (n > 0) numerator += BigInt(n) * BigInt(price);
  }
  const rounded = (numerator + 999999n) / 1000000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return {knownMicrodollars: 0, complete: false, overflow: true};
  return {knownMicrodollars: Number(rounded), complete, overflow: false};
}

// A conservative caller-supplied tokenizer/image bound is required. Raw
// prompts/images/URLs are deliberately neither accepted nor persisted.
function ceilingFor(rate, descriptor) {
  if (!rate) return null;
  if (rate.billing === 'calls') return rate.microdollarsPerCall; // one physical request
  if (rate.billing === 'audio_tokens') {
    const priced = priceTokens({textInput:descriptor.maxTextInputTokens, audioInput:descriptor.maxAudioInputTokens, output:descriptor.maxOutputTokens}, rate);
    return priced.complete ? priced.knownMicrodollars : null;
  }
  const input = descriptor.maxInputTokens, images = descriptor.maxImageTokens;
  if (!integer(input) || !integer(images) || !integer(input + images)) return null;
  const tokens = {input: input + images, output: descriptor.maxOutputTokens,
    cacheRead: descriptor.cacheEnabled === false ? 0 : descriptor.maxCacheReadTokens,
    cacheWrite: descriptor.cacheEnabled === false ? 0 : descriptor.maxCacheWriteTokens};
  const priced = priceTokens(tokens, rate);
  return priced.complete ? priced.knownMicrodollars : null;
}

// Forecast only: never called from the observation dispatch path. The caller
// must read the current policy and all state in ONE future reserve transaction.
// Per-day state includes today's liability, plus a separate prior-day risk hold.
function prospectiveAllowance({policy, ceilingMicrodollars, state} = {}) {
  const deny = reason => ({allowed: false, reason, prospectiveOnly: true});
  try { policy = validatePolicy(policy); } catch { return deny('invalid_policy'); }
  if (policy.emergencyStop) return deny('emergency_stop');
  if (!integer(ceilingMicrodollars)) return deny('unknown_charge');
  const limits = policy.limits;
  const checks = [['attempt', 'attemptMicrodollars'], ['accountDay', 'accountDayMicrodollars'], ['globalDay', 'globalDayMicrodollars']];
  if (!integer(state?.attempt?.physicalCalls)) return deny('unknown_spend');
  if (limits.attemptCalls !== null && BigInt(state.attempt.physicalCalls) + 1n > BigInt(limits.attemptCalls)) return deny('attempt_calls');
  for (const [scope, limitKey] of checks) {
    const s = state?.[scope];
    const keys = ['knownActualMicrodollars', 'uncertainLiabilityMicrodollars', 'unknownLiabilityCalls',
      'priorDayRiskMicrodollars', 'priorDayUnknownLiabilityCalls'];
    if (!s || keys.some(key => !integer(s[key]))) return deny('unknown_spend');
    if (s.unknownLiabilityCalls || s.priorDayUnknownLiabilityCalls) return deny('unknown_liability');
    const next = BigInt(s.knownActualMicrodollars) + BigInt(s.uncertainLiabilityMicrodollars) +
      BigInt(s.priorDayRiskMicrodollars) + BigInt(ceilingMicrodollars);
    if (limits[limitKey] !== null && next > BigInt(limits[limitKey])) return deny(limitKey);
  }
  return {allowed: true, reason: null, prospectiveOnly: true};
}

// Only call with matching global/account lifetime and current-day counters
// read atomically. Outstanding prior-day risk is NOT today's settled spend.
function priorDayRisk(lifetime, today) {
  const result = {};
  for (const [key, output] of [['uncertainLiabilityMicrodollars', 'priorDayRiskMicrodollars'],
    ['unknownLiabilityCalls', 'priorDayUnknownLiabilityCalls']]) {
    if (!integer(lifetime?.[key]) || !integer(today?.[key]) || lifetime[key] < today[key]) throw new Error('Invalid risk counters');
    result[output] = lifetime[key] - today[key];
  }
  return result;
}

module.exports = {DEFAULT_POLICY, DEFAULT_PRICES, DEFAULT_MEDIA_PRICES, TOKENS, AUDIO_TOKENS, tokenKeysFor, usageFrom, validatePolicy, validatePrices,
  priceTokens, ceilingFor, prospectiveAllowance, priorDayRisk};
