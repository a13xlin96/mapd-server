'use strict';
const {EngineError} = require('./engineError');

// Only the text-AI identity changes; source, Google and media caches stay intact.
const AI_RESPONSE_VERSION = '2';
const MAX_RESPONSE_BYTES = 65536;
const REASONS = new Set([
  'envelope', 'stop_max_tokens', 'stop_refusal', 'stop_other', 'refusal',
  'response_too_large', 'format_empty', 'format_framing', 'format_json',
  'format_duplicate_key', 'format_depth',
  'tool_blocks', 'tool_metadata', 'tool_caller',
  'media_input', 'media_shape', 'media_observations', 'media_reference', 'media_grounding',
  'schema_places', 'schema_verification', 'schema_regions',
]);
function diagnosticReason(error) {
  return REASONS.has(error?.aiResponseReason) ? error.aiResponseReason : undefined;
}
function attachDiagnostic(error, source) {
  const reason = diagnosticReason(source);
  // Public failure serialization and object spreads must not copy diagnostics.
  if (reason) Object.defineProperty(error, 'aiResponseReason', {value:reason});
  return error;
}
function invalidResponse(reason, stage = 'ai') {
  return attachDiagnostic(new EngineError('invalid_response', {stage, provider:'anthropic'}), {aiResponseReason:reason});
}

function parseResponse(message) {
  if (!message || typeof message !== 'object') throw invalidResponse('envelope');
  if (message.stop_reason !== 'end_turn') {
    throw invalidResponse(message.stop_reason === 'max_tokens' ? 'stop_max_tokens'
      : message.stop_reason === 'refusal' ? 'stop_refusal' : 'stop_other');
  }
  if (!Array.isArray(message.content) || !message.content.length || message.content.length > 8) {
    throw invalidResponse('envelope');
  }
  let bytes = 0;
  const parts = message.content.map((block, index) => {
    if (block?.type === 'refusal') throw invalidResponse('refusal');
    if (block?.type !== 'text' || typeof block.text !== 'string') throw invalidResponse('envelope');
    bytes += Buffer.byteLength(block.text, 'utf8') + (index ? 1 : 0);
    if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse('response_too_large');
    return block.text;
  });
  let text = parts.join('\n').trim();
  if (!text) throw invalidResponse('format_empty');

  // A small literal allowlist, never arbitrary prose around the first object.
  // This also prevents a refusal followed by a JSON example becoming success.
  text = text.replace(/^(?:Here is the (?:JSON|result)|JSON|Result):\s*/i, '');
  if (text.startsWith('```')) {
    // Delimiter checks avoid a backtracking regex on long malformed fences.
    if (text.length < 6 || !text.endsWith('```')) throw invalidResponse('format_framing');
    text = text.slice(3, -3).replace(/^json/i, '').trim();
  }
  if (!text.startsWith('{') && !text.startsWith('[')) throw invalidResponse('format_framing');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw invalidResponse('format_json'); } // Never retain the SyntaxError (may contain response text).

  // JSON.parse accepts duplicate keys, including differently escaped spellings.
  // Scan the already valid JSON so no competing value can silently win. Strings
  // are consumed whole, including escaped quotes/braces; work is bounded by bytes.
  const stack = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{' || value === '[') {
      stack.push(value === '{' ? new Set() : null);
      if (stack.length > 16) throw invalidResponse('format_depth');
    } else if (value === '}' || value === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(token.index + value.length))) {
      const key = JSON.parse(value), keys = stack[stack.length - 1];
      if (keys.has(key)) throw invalidResponse('format_duplicate_key');
      keys.add(key);
    }
  }
  return parsed;
}

function objectWithKeys(value, allowed, required = allowed) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}

module.exports = {AI_RESPONSE_VERSION, MAX_RESPONSE_BYTES, parseResponse,
  invalidResponse, objectWithKeys, diagnosticReason, attachDiagnostic};
