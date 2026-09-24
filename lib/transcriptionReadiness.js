'use strict';

const {MODEL} = require('./media/providers/openaiTranscription');
const {createEngineFeatures} = require('./engineFeatures');

// A local configuration check only: never contacts OpenAI, activates media,
// or logs keys, account IDs, rollout JSON, or provider responses.
function transcriptionReadiness(env = process.env) {
  let mediaEnrollment = 'off';
  try {
    const config = JSON.parse(env.ENGINE_ROLLOUT_JSON || '{}');
    createEngineFeatures(config);
    if (config.flags?.mediaEvidence === true) mediaEnrollment = 'configured';
  } catch {
    mediaEnrollment = 'invalid_config';
  }
  return {
    event: 'transcription_readiness',
    apiKeyConfigured: typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0,
    model: MODEL,
    modelAccess: 'not_tested',
    mediaEnrollment,
  };
}

module.exports = {transcriptionReadiness};
