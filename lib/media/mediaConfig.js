'use strict';

const MEDIA_FEATURE_VERSION = 'media-evidence-v1';
const DEFAULT_MEDIA_CONFIG = Object.freeze({
  schemaVersion: 1, policyVersion: 'media-v1', provider: 'openai',
  model: 'gpt-4o-mini-transcribe-2025-12-15', framePolicy: 'scene-grid-v1',
  maxDurationMs: 180000, maxDownloadBytes: 64 * 1024 * 1024,
  maxWorkspaceBytes: 128 * 1024 * 1024, downloadTimeoutMs: 25000,
  requestTimeoutMs: 20000, mediaTimeoutMs: 60000, reserveTailMs: 30000,
  audioChunkMs: 20000, audioOverlapMs: 1000, audioConcurrency: 2,
  providerSlots: 4, decodeConcurrency: 1, scanFps: 6, scanLongEdge: 320,
  maxCandidates: 240, initialFrames: 8, maxFrames: 16, frameLongEdge: 1280,
  artifactTtlSeconds: 86400, manifestTtlSeconds: 3600,
});

/** Validate trusted server policy or an immutable recorded policy; no request body. */
function validateMediaConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_MEDIA_CONFIG, key))) throw new TypeError('Invalid media policy');
  const config = {...DEFAULT_MEDIA_CONFIG, ...value};
  if (config.schemaVersion !== 1 || config.policyVersion !== 'media-v1' || config.provider !== 'openai'
      || !['gpt-4o-mini-transcribe-2025-12-15'].includes(config.model) || config.framePolicy !== 'scene-grid-v1') {
    throw new TypeError('Unsupported media policy/provider/model');
  }
  for (const key of Object.keys(DEFAULT_MEDIA_CONFIG).filter(key => typeof DEFAULT_MEDIA_CONFIG[key] === 'number')) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > DEFAULT_MEDIA_CONFIG[key]) throw new TypeError('Invalid media resource bound');
  }
  if (config.audioChunkMs < 2000 || config.reserveTailMs !== 30000 || config.audioOverlapMs >= config.audioChunkMs || config.initialFrames > config.maxFrames
      || config.requestTimeoutMs > config.mediaTimeoutMs || config.manifestTtlSeconds > config.artifactTtlSeconds) throw new TypeError('Invalid media policy relationship');
  return Object.freeze(config);
}

/** Capability declares UI compatibility only; authentication/cohorts remain authoritative. */
function hasRecoveryCapability(capabilities) {
  return Array.isArray(capabilities) && capabilities.length === 1
    && capabilities.every(value => value === 'mediaRecoveryV1')
    && capabilities.includes('mediaRecoveryV1');
}

function mediaConfigForFeatures(features) {
  if (features?.schemaVersion !== 2 || features?.versions?.mediaEvidence !== MEDIA_FEATURE_VERSION) return null;
  if (!features.media || features.media.recoveryCapability !== 'mediaRecoveryV1') return null;
  return validateMediaConfig(features.media.policy);
}
module.exports = {MEDIA_FEATURE_VERSION, DEFAULT_MEDIA_CONFIG, validateMediaConfig, hasRecoveryCapability, mediaConfigForFeatures};
