'use strict';
const {EngineError} = require('./engineError');

// A retry names the failed generation returned by this same operation. The
// shared store binds it to the authenticated scope + complete input identity
// and gives that generation only one successor, even after a lost HTTP reply.
function privateAiOptions(req) {
  const retryGeneration = req.body?.retryGeneration;
  if (retryGeneration !== undefined && (!Number.isSafeInteger(retryGeneration) || retryGeneration < 1)) {
    throw new EngineError('invalid_response', {stage:'input'});
  }
  return {scope:`user:${req.authUid}`,
    ...(retryGeneration === undefined ? {} : {retryGeneration})};
}

module.exports = {privateAiOptions};
