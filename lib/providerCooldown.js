'use strict';
const {EngineError, retryAfter} = require('./engineError');
const metrics = require('./engineMetrics');
const jobContext = require('./jobContext');

// Both the deadline and its expiry use the Redis clock. A short response may
// extend a key's lifetime, but may never shorten an existing cooldown.
const RECORD = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local old = redis.call('GET', KEYS[1])
if old and not tonumber(old) then return redis.error_reply('invalid cooldown') end
local untilMs = math.max(tonumber(old) or 0, now + tonumber(ARGV[1]))
redis.call('PSETEX', KEYS[1], math.max(1, untilMs - now), tostring(untilMs))
return math.ceil((untilMs - now) / 1000)`;
const REMAINING = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local old = redis.call('GET', KEYS[1])
if old and not tonumber(old) then return redis.error_reply('invalid cooldown') end
return math.max(0, math.ceil(((tonumber(old) or 0) - now) / 1000))`;

function createCooldownStore({redis, now = Date.now, allowLocal} = {}) {
  const local = new Map(), unpersisted = new Map();
  const localAllowed = () => allowLocal === true || (allowLocal !== false &&
    (['test', 'development'].includes(process.env.NODE_ENV) || process.env.ENGINE_SINGLE_PROCESS === 'true'));
  const failure = cause => new EngineError('dependency_error', {stage:'coordination', provider:'redis', cause});
  function checkLocal() { if (!localAllowed()) throw failure(new Error('Cooldown coordination unavailable')); }
  function seconds(error) {
    const parsed = error.retryAfterSeconds ?? retryAfter(error.retryAfter ?? error.response?.headers?.['retry-after'], now());
    return Number.isFinite(parsed) ? Math.min(86400, Math.max(1, Math.ceil(parsed))) : 60;
  }
  function checked(value) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('Invalid cooldown store response');
    return Number(value);
  }
  async function cooldownRemaining(provider) {
    if (unpersisted.has(provider) && unpersisted.get(provider) > now()) throw failure(new Error('Cooldown write has not been persisted'));
    unpersisted.delete(provider);
    if (redis) {
      try { return checked(await redis.eval(REMAINING, [`engine:cooldown:${provider}`], [])); }
      catch (cause) { throw failure(cause); }
    }
    checkLocal();
    const remaining = Math.max(0, Math.ceil(((local.get(provider) || 0) - now()) / 1000));
    if (!remaining) local.delete(provider);
    return remaining;
  }
  async function recordCooldown(provider, error) {
    if (error?.code !== 'rate_limited') return;
    const duration = seconds(error);
    const telemetry=metrics.current() || jobContext.current()?.sharedMetrics;
    telemetry?.operation('providerRejections', 1);
    telemetry?.operation('cooldownMs', duration * 1000);
    if (redis) {
      try {
        // Retry a previous failed write with at least its remaining duration.
        const ms = Math.max(duration * 1000, unpersisted.has(provider) ? unpersisted.get(provider) - now() : 0);
        const coveredUntil = now() + ms;
        const remaining = checked(await redis.eval(RECORD, [`engine:cooldown:${provider}`], [ms]));
        // A concurrent longer write may have failed while this write was in
        // flight. Only clear failures covered by the duration actually sent.
        if ((unpersisted.get(provider) || 0) <= coveredUntil) unpersisted.delete(provider);
        return remaining;
      } catch (cause) {
        unpersisted.set(provider, Math.max(unpersisted.get(provider) || 0, now() + duration * 1000));
        console.warn('Provider cooldown persistence failed', {provider, code:'coordination_unavailable'});
        throw failure(cause);
      }
    }
    checkLocal();
    local.set(provider, Math.max(local.get(provider) || 0, now() + duration * 1000));
    return cooldownRemaining(provider);
  }
  return {cooldownRemaining, recordCooldown};
}
const store = createCooldownStore({redis:require('./cache').redis});
module.exports = {createCooldownStore, ...store};
