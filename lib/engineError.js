// Stable public failure contract. Provider messages remain in private stage logs.
const MESSAGES = {
  attempt_stopped: 'This attempt has stopped. Start a new retry to continue.',
  queue_full: 'You have several links processing. Retry this one after they finish.',
  rate_limited: 'The source is temporarily limiting requests. You can retry later.',
  access_blocked: 'We could not read this post. Try again later or add the place manually.',
  dependency_timeout: 'Processing took too long. You can retry or add the place manually.',
  dependency_error: 'A service needed to process this link is unavailable. You can retry later.',
  invalid_response: 'We could not reliably read the processing result. You can retry.',
  input_too_large: 'This post is too large to process in one attempt. Add the place manually.',
  no_place_found: 'We read the available text but could not identify a specific place.',
  no_verified_match: 'We found a possible place but could not verify its location.',
  source_unavailable: 'We could not read enough of this post to identify a place.',
};
class EngineError extends Error {
  constructor(code, {stage = 'extraction', provider = 'engine', retryAfterSeconds, cause} = {}) {
    super(MESSAGES[code] || MESSAGES.dependency_error, {cause});
    this.name = 'EngineError'; this.code = code; this.stage = stage; this.provider = provider;
    if (Number.isFinite(retryAfterSeconds)) this.retryAfterSeconds = Math.min(86400, Math.max(0, Math.ceil(retryAfterSeconds)));
  }
}
function retryAfter(value, now = Date.now()) {
  if (value == null) return undefined;
  const seconds = /^\d+$/.test(String(value).trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(0, Math.ceil(seconds))) : undefined;
}
function asEngineError(error, context = {}) {
  if (error instanceof EngineError) return error;
  const status = Number(error?.status || error?.response?.status);
  const message = String(error?.message || '');
  const code = status === 429 || /429|rate.?limit|too many requests/i.test(message) ? 'rate_limited'
    : status === 401 || status === 403 || error?.code === 'IP_BLOCKED' ? 'access_blocked'
    : /timeout|timed out|aborted/i.test(message) || ['AbortError','TimeoutError'].includes(error?.name) ? 'dependency_timeout'
    : 'dependency_error';
  return new EngineError(code, {...context, retryAfterSeconds:retryAfter(error?.response?.headers?.['retry-after'] || error?.retryAfter), cause:error});
}
function failureOf(error, context) {
  const e = asEngineError(error, context);
  return {code:e.code,stage:e.stage,provider:e.provider,message:e.message,
    ...(e.retryAfterSeconds == null ? {} : {retryAfterSeconds:e.retryAfterSeconds}),
    ...(Number.isSafeInteger(e.retryGeneration) && e.retryGeneration > 0 ? {retryGeneration:e.retryGeneration} : {}),
    // Informational only: failed jobs never schedule themselves for retry.
    requiresUserAction:true};
}
module.exports = {EngineError, asEngineError, failureOf, retryAfter, MESSAGES};
