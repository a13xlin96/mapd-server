'use strict';
const {createHash, randomUUID} = require('crypto');
const {EngineError} = require('./engineError');
// This capability cannot be manufactured by JSON request bodies. Only server
// code that fetched public evidence may pass it to an adapter.
const SERVER_PUBLIC_SCOPE = Symbol('server-public-evidence');
function plainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  // VM/evaluator JSON objects have a different Object.prototype identity.
  // Accept their native Object prototype, plus null-prototype dictionaries,
  // without allowing Date, class instances, or custom prototype chains.
  return prototype === null || (Object.getPrototypeOf(prototype) === null &&
    typeof prototype.constructor === 'function' &&
    Function.prototype.toString.call(prototype.constructor) === Function.prototype.toString.call(Object));
}
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plainObject(value)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new EngineError('invalid_response', {stage:'input'});
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function identity(options) {
  const {kind, input, model, promptVersion, schemaVersion, optionsVersion} = options;
  if (![kind, model, promptVersion, schemaVersion, optionsVersion].every(v =>
    (typeof v === 'string' && v.length > 0 && v.length <= 128) || (typeof v === 'number' && Number.isFinite(v)))) {
    throw new EngineError('invalid_response', {stage:'input'});
  }
  const scope = options.scope === SERVER_PUBLIC_SCOPE ? 'server-public' :
    typeof options.scope === 'string' && /^user:.{1,128}$/.test(options.scope) ? options.scope : null;
  const encoded = canonical({kind, input, model, promptVersion, schemaVersion, optionsVersion, scope:scope || randomUUID()});
  if (Buffer.byteLength(encoded) > 128 * 1024) throw new EngineError('input_too_large', {stage:'input'});
  return {key:createHash('sha256').update(encoded).digest('hex'), cacheable:!!scope};
}
module.exports = {SERVER_PUBLIC_SCOPE, canonical, digest, identity};
