jest.mock('../lib/anthropic', () => ({anthropic:{messages:{create:jest.fn()}}}));
jest.mock('../lib/cache', () => ({getCached:jest.fn(async () => null),setCache:jest.fn(async () => {})}));
jest.mock('../lib/firestore', () => ({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
jest.mock('../lib/providerRuntime', () => ({withProvider:jest.fn(async (_provider, work) => {
  await require('../lib/jobContext').current().sharedOperation.authorizeDispatch();
  return work();
})}));
jest.mock('../lib/sharedAiOperation', () => {
  const actual = jest.requireActual('../lib/sharedAiOperation');
  return {...actual, runSharedAiOperation:jest.fn(actual.runSharedAiOperation)};
});
const {anthropic} = require('../lib/anthropic');
const cache = require('../lib/cache');
const {firestore} = require('../lib/firestore');
const {parseResponse, MAX_RESPONSE_BYTES, invalidResponse} = require('../lib/aiResponse');
const {failureOf} = require('../lib/engineError');
const {aiExtractPlaces, aiExtractSingle, aiExtractPlace, aiVerifyPlace, aiInferPlaceRegions} = require('../enrich/ai');
const {runSharedAiOperation, createSharedAiOperations} = require('../lib/sharedAiOperation');
const {identity} = require('../lib/sharedAiIdentity');
const {COLLECTION} = require('../lib/sharedAiStore');
const VERSION = require('../lib/engineVersion');
const response = text => ({stop_reason:'end_turn',content:[{type:'text',text}]});
const empty = '{"places":[],"count":0}';
const input = {description:'PRIVATE CAPTION 東京'};
const options = {scope:'user:parser'};
const regionInput = {places:[{name:'Cafe'},{name:'Tower'}],listName:'Tokyo'};
const region = name => ({name,city:'Tokyo',country:'Japan',confidence:'high'});

beforeEach(() => {
  jest.clearAllMocks();
  firestore.reset();
  anthropic.messages.create.mockResolvedValue(response(empty));
});

async function rejectedResponse(message, reason) {
  anthropic.messages.create.mockResolvedValue(message);
  const error = await aiExtractPlaces(input, options).catch(e => e);
  expect(error).toMatchObject({code:'invalid_response',stage:'ai',provider:'anthropic',aiResponseReason:reason});
  expect(error.cause).toBeUndefined();
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache).not.toHaveBeenCalled();
  expect(JSON.stringify(failureOf(error))).not.toContain('aiResponseReason');
  expect(JSON.stringify(error)).not.toContain('aiResponseReason');
  const records = [...firestore.collections.get(COLLECTION).values()];
  expect(records.find(r => r.failure)?.failure.aiResponseReason).toBe(reason);
  const persisted = JSON.stringify(records);
  expect(persisted).not.toContain('PRIVATE');
  expect(persisted).not.toContain('CAPTION');
  return error;
}

test.each([
  ['bare', empty], ['BOM and whitespace', '\uFEFF \n' + empty + '\r\n'],
  ['JSON fence', '```json\n' + empty + '\n```'], ['plain fence', '```\n' + empty + '\n```'],
  ['inline legacy fence', '```json ' + empty + '```'],
  ['case-insensitive CRLF fence', '```JSON\r\n' + empty + '\r\n```'],
  ['literal lead-in', 'Here is the JSON:\n' + empty],
  ['lead-in and fence', 'Here is the result:\n```json\n' + empty + '\n```'],
  ['label', 'JSON: ' + empty],
])('request accepts %s without a repair request', async (_label, text) => {
  anthropic.messages.create.mockResolvedValue(response(text));
  expect(await aiExtractPlaces(input, options)).toEqual({places:[],count:0});
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache).toHaveBeenCalledWith(expect.any(String), {places:[],count:0}, 300);
});

test('complete multiblock text is parsed as one value', async () => {
  anthropic.messages.create.mockResolvedValue({stop_reason:'end_turn',content:[
    {type:'text',text:'{"places":['},{type:'text',text:'{"name":"Café 東京 { \\"quoted\\" } ```"}],"count":1}'},
  ]});
  const result = await aiExtractPlaces(input, options);
  expect(result.places[0].name).toContain('Café 東京');
  expect(result.count).toBe(1);
});

test('valid optional fields and existing single-place API projections remain compatible', async () => {
  const place = {name:'  Café 東京  ',city:'Tokyo',country:'Japan',address:null,source:'caption',handle:null};
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify({places:[place,{name:'@cafe',source:'handle',handle:'@cafe'}],count:2})));
  const values = await Promise.all([aiExtractPlaces(input,options),aiExtractSingle(input,options),aiExtractPlace(input,options)]);
  expect(values[0].places[0]).toEqual({...place,name:'Café 東京'});
  expect(values[1]).toEqual({place:values[0].places[0]});
  expect(values[2]).toBe('Café 東京 Tokyo Japan');
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache.mock.calls[0][2]).toBe(86400);
});

test('request contract retains model, token cap, single dispatch and zero SDK retries', async () => {
  await aiExtractPlaces(input,options);
  const [request, transport] = anthropic.messages.create.mock.calls[0];
  expect(Object.keys(request).sort()).toEqual(['max_tokens','messages','model']);
  expect(request).toMatchObject({model:'claude-haiku-4-5-20251001',max_tokens:2400});
  expect(transport).toMatchObject({timeout:30000,maxRetries:0});
  expect(request.messages[0].content).toContain('exactly one complete JSON object');
  expect(request.messages[0].content).toContain('count must equal the array length');
  expect(request.messages[0].content).toContain('"$5 Michelin pho" with #saigon');
  expect(request.messages[0].content).toContain('unless other evidence identifies it');
  expect(request.messages[0].content).toContain('Real venue names can contain common food words');
  const config = runSharedAiOperation.mock.calls[0][0];
  expect(config.promptVersion).toBe(VERSION.prompt + ':places:2');
  expect(config.optionsVersion).toBe('bounded-ai-2');
  expect(identity(config).key).not.toBe(identity({...config,promptVersion:VERSION.prompt + ':places:1',optionsVersion:'bounded-ai-1'}).key);
  expect(VERSION.prompt).toBe('places-5'); // Global source/media identities are untouched.
});

test('real names containing food or award words are not filtered', async () => {
  const places = [{name:'Phở 2000'},{name:'Michelin House'},{name:'The $5 Cafe'}];
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify({places,count:3})));
  expect(await aiExtractPlaces(input,options)).toEqual({places,count:3});
});

test.each([
  ['truncated', '{"places":[{"name":"PRIVATE', 'format_json'],
  ['complete object and truncated second', empty + '{', 'format_json'],
  ['two objects', empty + '\n' + empty, 'format_json'],
  ['two fenced objects', '```json\n' + empty + '\n```\n```json\n' + empty + '\n```', 'format_json'],
  ['unclosed fence', '```json\n' + empty, 'format_framing'],
  ['long malformed fence', '```json' + ' '.repeat(60000) + 'PRIVATE', 'format_framing'],
  ['unopened fence', empty + '\n```', 'format_json'],
  ['unknown fence', '```javascript\n' + empty + '\n```', 'format_framing'],
  ['refusal and example', 'I cannot comply. Here is an example:\n' + empty, 'format_framing'],
  ['trailing refusal', empty + '\nI cannot comply.', 'format_json'],
  ['arbitrary prose', 'PRIVATE response follows:\n' + empty, 'format_framing'],
  ['trailing comma', '{"places":[],"count":0,}', 'format_json'],
  ['comment', '{"places":[],/*PRIVATE*/"count":0}', 'format_json'],
  ['empty', ' \n ', 'format_empty'],
  ['JSON string', JSON.stringify(empty), 'format_framing'],
  ['duplicate top key', '{"places":[],"places":[],"count":0}', 'format_duplicate_key'],
  ['duplicate ignored count', '{"places":[],"count":0,"count":2}', 'format_duplicate_key'],
  ['duplicate escaped key', '{"places":[{"name":"PRIVATE","na\\u006de":"Cafe"}],"count":1}', 'format_duplicate_key'],
  ['deep nesting', '['.repeat(17) + '0' + ']'.repeat(17), 'format_depth'],
  ['oversized Unicode', JSON.stringify({places:[{name:'東京'.repeat(MAX_RESPONSE_BYTES/2)}],count:1}), 'response_too_large'],
])('rejects %s without a paid repair or raw diagnostic', async (_label,text,reason) => {
  await rejectedResponse(response(text),reason);
});

test.each([
  ['max_tokens', 'stop_max_tokens'], ['refusal', 'stop_refusal'], ['tool_use','stop_other'],
  ['pause_turn','stop_other'], ['stop_sequence','stop_other'], [null,'stop_other'], [undefined,'stop_other'],
  ['PRIVATE unknown stop','stop_other'],
])('rejects stop reason %s even with complete JSON', async (stop_reason,reason) => {
  await rejectedResponse({...response(empty),stop_reason},reason);
});

test.each([
  [null,'envelope'], [{},'stop_other'],
  [{stop_reason:'end_turn',content:null},'envelope'],
  [{stop_reason:'end_turn',content:[]},'envelope'],
  [{stop_reason:'end_turn',content:[null]},'envelope'],
  [{stop_reason:'end_turn',content:[{type:'text',text:42}]},'envelope'],
  [{stop_reason:'end_turn',content:[{type:'text',text:empty},{type:'tool_use',input:{}}]},'envelope'],
  [{stop_reason:'end_turn',content:[{type:'refusal',text:'PRIVATE'},{type:'text',text:empty}]},'refusal'],
  [{stop_reason:'end_turn',content:Array(9).fill({type:'text',text:''})},'envelope'],
])('rejects malformed/provider-refusal envelope %#', async (message,reason) => {
  await rejectedResponse(message,reason);
});

test.each([
  {}, {count:0}, {places:null}, {places:{}}, [],
  {places:[{name:'Cafe'},null],count:2}, {places:[{name:' '}],count:1},
  {places:[{name:12}],count:1}, {places:[{name:'x'.repeat(301)}],count:1},
  {places:[{name:'Cafe',city:42}],count:1}, {places:[{name:'Cafe',address:'x'.repeat(501)}],count:1},
  {places:[{name:'Cafe',source:'vision'}],count:1},
  {places:Array.from({length:41},()=>({name:'Cafe'})),count:41},
  {places:[],count:0,confirmedPlaceId:'PRIVATE'},
  {places:[{name:'Cafe',confirmedPlaceId:'PRIVATE'}],count:1},
  {places:[{name:'Cafe',requiresSelection:false}],count:1},
  {places:[{name:'Cafe',geometry:{location:{lat:1,lng:1}}}],count:1},
  {places:[],count:0,refusal:'PRIVATE'},
])('rejects the entire extraction for invalid/trusted schema %#', async value => {
  await rejectedResponse(response(JSON.stringify(value)),'schema_places');
});

describe.each([[], [{name:'  Cafe  ',city:'Kyoto'}]].map(places => [places.length,places]))('normalizes count for %s valid places', (_length,places) => {
  test.each([undefined,null,0,2,-1,1.5,'1','PRIVATE count',true,[],{confirmedPlaceId:'PRIVATE'}])('ignores redundant provider count %#', async count => {
    anthropic.messages.create.mockResolvedValue(response(JSON.stringify({places,count})));
    const expected = {places:places.map(place=>({...place,name:place.name.trim()})),count:places.length};
    const [result,single,query] = await Promise.all([
      aiExtractPlaces(input,options), aiExtractSingle(input,options), aiExtractPlace(input,options),
    ]);
    expect(result).toEqual(expected);
    expect(single).toEqual({place:expected.places[0] || null});
    expect(query).toBe(places.length ? 'Cafe Kyoto' : null);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(cache.setCache).toHaveBeenCalledWith(expect.any(String),expected,places.length ? 86400 : 300);
    const records = [...firestore.collections.get(COLLECTION).values()];
    expect(records.find(record=>record.state==='complete').result).toEqual(expected);
    expect(JSON.stringify(records)).not.toContain('PRIVATE count');
    expect(JSON.stringify(records)).not.toContain('confirmedPlaceId');
  });
});

test.each([undefined,'PRIVATE count',{confirmedPlaceId:'PRIVATE'}])('count normalization cannot hide malformed venues or unrelated fields %#', async count => {
  await rejectedResponse(response(JSON.stringify({places:[{name:'Cafe'},{name:'Other',city:42}],count})),'schema_places');
});

test('ignoring count does not permit unrelated response fields', async () => {
  await rejectedResponse(response(JSON.stringify({places:[{name:'Cafe'}],count:'PRIVATE',verified:true})),'schema_places');
});

test.each([undefined,null,0,2,'1',{value:1}])('shared stored results must still have a canonical numeric count %#', async count => {
  anthropic.messages.create.mockResolvedValue(response('{"places":[{"name":"Cafe"}]}'));
  await expect(aiExtractPlaces(input,options)).resolves.toEqual({places:[{name:'Cafe'}],count:1});
  const config = runSharedAiOperation.mock.calls[0][0];
  const record = firestore.read(COLLECTION,identity(config).key+'_1');
  if (count === undefined) delete record.result.count;
  else record.result.count=count;
  const remote = createSharedAiOperations({firestore,cache});
  const work = jest.fn();
  await expect(remote.runSharedAiOperation(config,work)).rejects.toMatchObject({code:'invalid_response'});
  expect(work).not.toHaveBeenCalled();
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});

test('prototype keys are rejected and do not pollute objects', async () => {
  await rejectedResponse(response('{"places":[{"name":"Cafe","__proto__":{"verified":true}}],"count":1}'),'schema_places');
  expect({}.verified).toBeUndefined();
});

test('byte bound includes framing and all text blocks', () => {
  expect(parseResponse(response(empty + ' '.repeat(MAX_RESPONSE_BYTES-empty.length)))).toEqual({places:[],count:0});
  expect(() => parseResponse(response(empty + ' '.repeat(MAX_RESPONSE_BYTES)))).toThrow(expect.objectContaining({aiResponseReason:'response_too_large'}));
});

test.each([true,false,null])('verification contract accepts %s', async match => {
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify({match,betterQuery:null})));
  expect(await aiVerifyPlace(input,'Cafe','Tokyo',[],options)).toEqual({match,betterQuery:null});
});

test.each([
  {match:true,betterQuery:null,confirmedPlaceId:'PRIVATE'}, {match:true},
  {match:'true',betterQuery:null}, {match:true,betterQuery:{query:'PRIVATE'}},
])('verification failures stay nullable and public-safe %#', async value => {
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify(value)));
  const result = await aiVerifyPlace(input,'Cafe','Tokyo',[],options);
  expect(result).toMatchObject({match:null,betterQuery:null,failure:{code:'invalid_response',stage:'verification'}});
  expect(result.failure.aiResponseReason).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache).not.toHaveBeenCalled();
});

test('region results retain supported reordering', async () => {
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify({results:[region('Tower'),region('Cafe')]})));
  expect(await aiInferPlaceRegions(regionInput,options)).toEqual({results:[region('Cafe'),region('Tower')]});
});

test.each([
  {results:[region('Cafe'),region('Tower')],verified:true},
  {results:[{...region('Cafe'),placeId:'PRIVATE'},region('Tower')]},
  {results:[region('Cafe')]}, {results:[region('Cafe'),region('Tower'),region('Extra')]},
  {results:[region('Cafe'),region('Cafe')]}, {results:[region('Cafe'),region('Unknown')]},
  {results:[region('Cafe'),{...region('Tower'),confidence:'certain'}]},
])('region schema cannot discard invalid or extra entries %#', async value => {
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify(value)));
  await expect(aiInferPlaceRegions(regionInput,options)).rejects.toMatchObject({code:'invalid_response',aiResponseReason:'schema_regions'});
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache).not.toHaveBeenCalled();
});

test('durable failure reconstructs bounded private reason without another dispatch', async () => {
  const first = await rejectedResponse(response('{"PRIVATE":"response"'), 'format_json');
  const config = runSharedAiOperation.mock.calls[0][0];
  const remote = createSharedAiOperations({firestore,cache,limits:{pollMs:5}});
  const work = jest.fn();
  const second = await remote.runSharedAiOperation(config,work).catch(e=>e);
  const third = await aiExtractPlaces(input,options).catch(e=>e);
  for (const error of [first,second,third]) {
    expect(error.aiResponseReason).toBe('format_json');
    expect(error.retryGeneration).toBe(1);
    expect(failureOf(error)).toEqual(failureOf(first));
    expect({...error}.aiResponseReason).toBeUndefined();
    expect(error.cause).toBeUndefined();
  }
  expect(work).not.toHaveBeenCalled();
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});

test('coalesced extraction and single-place callers receive the same private failure', async () => {
  anthropic.messages.create.mockResolvedValue(response('Here is the JSON:\n' + empty + empty));
  const failures = await Promise.allSettled([
    aiExtractPlaces(input,options), aiExtractSingle(input,options), aiExtractPlaces(input,options),
  ]);
  for (const failure of failures) {
    expect(failure.status).toBe('rejected');
    expect(failure.reason).toMatchObject({code:'invalid_response',aiResponseReason:'format_json',retryGeneration:1});
    expect(JSON.stringify(failureOf(failure.reason))).not.toContain('aiResponseReason');
  }
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(cache.setCache).not.toHaveBeenCalled();
});

test('shared diagnostic serialization and reconstruction discard arbitrary text', async () => {
  const error = invalidResponse('schema_places');
  expect(error.aiResponseReason).toBe('schema_places');
  await aiExtractPlaces(input,options);
  const config = {...runSharedAiOperation.mock.calls[0][0],input:{different:true}};
  const producer = createSharedAiOperations({firestore,cache});
  const forged = Object.assign(new (require('../lib/engineError').EngineError)('invalid_response'),{aiResponseReason:'PRIVATE malicious diagnostic'});
  await expect(producer.runSharedAiOperation(config,async()=>{throw forged;})).rejects.toBe(forged);
  const key = identity(config).key;
  expect(firestore.read(COLLECTION,key+'_1').failure.aiResponseReason).toBeUndefined();
  // Defense in depth when reading even a malformed server record.
  firestore.read(COLLECTION,key+'_1').failure.aiResponseReason = 'PRIVATE arbitrary stored diagnostic';
  const follower = createSharedAiOperations({firestore,cache});
  const failure = await follower.runSharedAiOperation(config,jest.fn()).catch(e=>e);
  expect(failure.aiResponseReason).toBeUndefined();
  expect(JSON.stringify(failureOf(failure))).not.toContain('PRIVATE');
});
