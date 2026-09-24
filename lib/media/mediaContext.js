'use strict';
const jobContext = require('../jobContext');
const {EngineError} = require('../engineError');

// Physical operation kinds, not feature flags or caller-selected budget policy.
const MEDIA_OPERATION_KINDS = Object.freeze(['asr_chunk', 'video_vision', 'media_fusion']);
const isMediaOperation = kind => MEDIA_OPERATION_KINDS.includes(kind);

/**
 * Creates a caller subscription with an earlier cutoff, WITHOUT changing the
 * job's save deadline or dropping lease/authority checks. Call dispose() in a
 * finally block. Shared producers deliberately receive their own context from
 * sharedAiOperation; never close over this signal when uploading shared work.
 * @param {object} parent trusted jobContext (defaults to the current context)
 * @param {{deadline?:number,maxDurationMs?:number,reserveMs?:number,now?:Function}} options
 * @returns {{context:object,run:Function,dispose:Function}}
 */
function createMediaContext(parent = jobContext.current(), {
  deadline, maxDurationMs = 60000, reserveMs = 30000, now = Date.now,
} = {}) {
  if (!parent || !Number.isFinite(parent.deadline) ||
      !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 60000 ||
      !Number.isFinite(reserveMs) || reserveMs < 0 ||
      (deadline !== undefined && !Number.isFinite(deadline))) {
    throw new EngineError('invalid_response', {stage:'media'});
  }
  const cutoff = Math.min(parent.deadline - reserveMs, now() + maxDurationMs, deadline ?? Infinity);
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.signal?.reason);
  parent.signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => controller.abort(new EngineError('dependency_timeout', {stage:'media'})),
    Math.max(0, cutoff - now()));
  timer.unref?.();
  if (parent.signal?.aborted) cancel();
  // Preserve non-copyable authority through an explicit parent link as well as
  // the inherited lease fields. The parent itself is never serialized.
  const context = {...parent, deadline:cutoff, signal:controller.signal,
    parentContext:parent, sharedMetrics:require('../engineMetrics').current() || parent.sharedMetrics};
  return Object.freeze({context, run:work => jobContext.run(context, work), dispose() {
    clearTimeout(timer); parent.signal?.removeEventListener('abort', cancel); controller.abort();
  }});
}

/**
 * withMediaContext(work, {parent?,deadline?,maxDurationMs?,reserveMs?}) runs
 * work(childContext) and disposes ONLY this subscriber's signal in finally.
 * Defaults come from the already-recorded job feature policy, not environment.
 * This is lifetime management, not feature admission; caller checks the feature.
 */
async function withMediaContext(work, {parent = jobContext.current(), ...options} = {}) {
  if (typeof work !== 'function') throw new TypeError('Media work must be a function');
  const policy = require('./mediaConfig').mediaConfigForFeatures(parent?.features);
  const scope = createMediaContext(parent, {
    ...(policy ? {maxDurationMs:policy.mediaTimeoutMs, reserveMs:policy.reserveTailMs} : {}), ...options,
  });
  try {return await scope.run(() => work(scope.context));}
  finally {scope.dispose();}
}

module.exports = {createMediaContext, withMediaContext, MEDIA_OPERATION_KINDS, isMediaOperation};
