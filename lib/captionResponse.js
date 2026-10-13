'use strict';
const {MAX_RESPONSE_BYTES, parseResponse, invalidResponse, objectWithKeys} = require('./aiResponse');

// Caption-only identity: changing the declaration/validation contract must not
// invalidate unrelated Google, source, transcription or vision operations.
const CAPTION_OUTPUT_VERSION = 'caption-tool-1';
const TOOL_NAME = 'submit_caption_places';
const MAX_PLACES = 40;
const PLACE_KEYS = ['name','city','country','address','source','handle'];
const SOURCES = ['caption','hashtag','transcript','handle'];
const objectSchema = (properties, required) => ({type:'object', properties, required, additionalProperties:false});

function captionToolOutput() {
  const geography = {type:['string','null'], maxLength:500};
  return {
    tools:[{name:TOOL_NAME,
      description:'Return named venue candidates supported by the supplied post evidence. This declaration only returns data and never saves, verifies, or looks up a place.',
      input_schema:objectSchema({places:{type:'array', maxItems:MAX_PLACES,
        items:objectSchema({name:{type:'string',minLength:1,maxLength:300},
          city:geography, country:geography, address:geography,
          source:{type:['string','null'],enum:[...SOURCES,null]}, handle:geography}, ['name'])},
        count:{type:'integer',minimum:0,maximum:MAX_PLACES}}, ['places'])}],
    tool_choice:{type:'tool',name:TOOL_NAME,disable_parallel_tool_use:true},
  };
}
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [null,Object.prototype].includes(Object.getPrototypeOf(value));
const fail = reason => {throw invalidResponse(reason);};

// The SDK has already decoded tool input. Bound and inspect its data before
// serializing; no getters, custom prototypes/toJSON, sparse arrays or cycles.
function ownJson(value) {
  let nodes=0, bytes=0;
  const count = length => {if ((bytes += length) > MAX_RESPONSE_BYTES) fail('response_too_large');};
  function visit(item, depth=0) {
    if (++nodes > MAX_RESPONSE_BYTES) fail('response_too_large');
    if (typeof item === 'string') {count(Buffer.byteLength(item,'utf8')); return;}
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!Array.isArray(item) && !plain(item)) fail('envelope');
    if (depth >= 16) fail('format_depth');
    const keys=Object.keys(item);
    if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== keys.length + (Array.isArray(item)?1:0)
      || (Array.isArray(item) && (keys.length !== item.length || keys.some((key,index)=>key!==String(index))))) fail('envelope');
    for (const key of keys) {
      count(Buffer.byteLength(key,'utf8'));
      const descriptor=Object.getOwnPropertyDescriptor(item,key);
      if (!Object.hasOwn(descriptor,'value')) fail('envelope');
      visit(descriptor.value,depth+1);
    }
  }
  visit(value);
  const encoded=JSON.stringify(value);
  if (Buffer.byteLength(encoded,'utf8') > MAX_RESPONSE_BYTES) fail('response_too_large');
  return JSON.parse(encoded);
}

function parseCaptionResponse(message) {
  // Retain the strict legacy end_turn parser for complete JSON responses. It
  // still rejects refusals, truncation, duplicates, prose and mixed tool/text.
  // This is not a second request or a permissive text salvage path.
  if (message?.stop_reason !== 'tool_use') return parseResponse(message);
  // A text response mislabeled tool_use must still fail the legacy stop check.
  if (Array.isArray(message.content) && message.content.length && message.content.every(block=>block?.type==='text')) return parseResponse(message);
  if (!plain(message)) fail('envelope');
  if (!Array.isArray(message.content) || message.content.length !== 1) fail('tool_blocks');
  const block=message.content[0];
  if (block?.type === 'refusal') fail('refusal');
  if (!plain(block) || block.type !== 'tool_use' || block.name !== TOOL_NAME
    || typeof block.id !== 'string' || !block.id.trim() || block.id.length > 200 || !plain(block.input)) fail('envelope');
  if (!objectWithKeys(block,['type','id','name','input','caller','toolset_name'],['type','id','name','input'])) fail('tool_metadata');
  if (Object.hasOwn(block,'caller') && (!plain(block.caller)
    || !objectWithKeys(block.caller,['type']) || block.caller.type !== 'direct')) fail('tool_caller');
  if (Object.hasOwn(block,'toolset_name') && block.toolset_name !== null) fail('tool_metadata');
  return ownJson(block.input);
}

function validPlace(place) {
  return objectWithKeys(place,PLACE_KEYS,['name'])
    && typeof place.name === 'string' && place.name.trim().length > 0 && place.name.length <= 300
    && (place.source == null || SOURCES.includes(place.source))
    && PLACE_KEYS.slice(1).every(key=>place[key] == null || (typeof place[key] === 'string' && place[key].length <= 500));
}

function normalizeCaptionResult(value) {
  // Root corruption or oversized arrays are not safe candidate-level failures.
  // In particular the model cannot set incomplete, verified, IDs or provenance.
  if (!objectWithKeys(value,['places','count'],['places']) || !Array.isArray(value.places)
    || value.places.length > MAX_PLACES) fail('schema_places');
  const places=value.places.filter(validPlace).map(place=>({...place,name:place.name.trim()}));
  if (value.places.length && !places.length) fail('schema_places');
  // Reject the entire privileged candidate; stripping its extra fields would
  // turn a malformed assertion into apparently clean evidence.
  return {places,count:places.length,...(places.length < value.places.length ? {incomplete:true} : {})};
}

function validCaptionResult(value) {
  // Shared/cached data is canonical. Never silently repair a corrupt stored
  // result, drop its incomplete flag, or normalize a forged numeric count.
  try {
    const result=ownJson(value);
    return objectWithKeys(result,['places','count','incomplete'],['places','count'])
      && Array.isArray(result.places) && result.places.length <= MAX_PLACES
      && result.places.every(place=>validPlace(place) && place.name===place.name.trim())
      && result.count===result.places.length
      && (!Object.hasOwn(result,'incomplete') || (result.incomplete===true && result.count>0 && result.count<MAX_PLACES));
  } catch {return false;}
}

module.exports={CAPTION_OUTPUT_VERSION,captionToolOutput,parseCaptionResponse,normalizeCaptionResult,validCaptionResult};
