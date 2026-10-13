jest.mock('../lib/anthropic',()=>({anthropic:{messages:{create:jest.fn()}}}));
jest.mock('../lib/cache',()=>({getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})}));
jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
jest.mock('../lib/providerRuntime',()=>({withProvider:jest.fn(async(_provider,work)=>{
  await require('../lib/jobContext').current().sharedOperation.authorizeDispatch();
  return work();
})}));
jest.mock('../lib/sharedAiOperation',()=>{
  const actual=jest.requireActual('../lib/sharedAiOperation');
  return {...actual,runSharedAiOperation:jest.fn(actual.runSharedAiOperation)};
});
const {anthropic}=require('../lib/anthropic');
const cache=require('../lib/cache');
const {firestore}=require('../lib/firestore');
const {aiExtractPlaces,aiVerifyPlace,SERVER_PUBLIC_SCOPE}=require('../enrich/ai');
const {runSharedAiOperation,createSharedAiOperations}=require('../lib/sharedAiOperation');
const {identity}=require('../lib/sharedAiIdentity');
const {COLLECTION}=require('../lib/sharedAiStore');
const {EngineError,failureOf}=require('../lib/engineError');
const {MAX_RESPONSE_BYTES,parseResponse}=require('../lib/aiResponse');
const {CAPTION_OUTPUT_VERSION,parseCaptionResponse}=require('../lib/captionResponse');
const VERSION=require('../lib/engineVersion');

const sushi={name:'鮨 うら山 本店 (Sushi Urayama Honten)',city:'Nagoya',country:'Japan',address:'Sakae, Nagoya, Aichi',source:'caption'};
const input={description:'PRIVATE caption: 鮨 うら山 本店 (Sushi Urayama Honten), Sakae, Nagoya, Aichi'};
const options={scope:'user:caption-output'};
const tool=(value={places:[sushi]})=>({stop_reason:'tool_use',content:[{
  type:'tool_use',id:'toolu_caption',name:'submit_caption_places',input:value,caller:{type:'direct'},
}]});
const request=(value)=>{
  anthropic.messages.create.mockResolvedValue(tool(value));
  return aiExtractPlaces(input,options);
};
beforeEach(()=>{
  jest.clearAllMocks();firestore.reset();
  cache.getCached.mockResolvedValue(null);
  anthropic.messages.create.mockResolvedValue(tool());
});

async function expectInvalid(message,reason) {
  anthropic.messages.create.mockResolvedValue(message);
  const error=await aiExtractPlaces(input,options).catch(e=>e);
  expect(error).toMatchObject({code:'invalid_response',stage:'ai',provider:'anthropic',aiResponseReason:reason});
  expect(cache.setCache).not.toHaveBeenCalled();
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(failureOf(error))).not.toContain('PRIVATE');
  expect(JSON.stringify(error)).not.toContain('aiResponseReason');
  const stored=JSON.stringify([...firestore.collections.get(COLLECTION).values()]);
  expect(stored).not.toContain('PRIVATE');
  return error;
}

test('caption request forces one bounded declaration and retains model, deadline and accounting',async()=>{
  await expect(aiExtractPlaces(input,options)).resolves.toEqual({places:[sushi],count:1});
  const [payload,transport]=anthropic.messages.create.mock.calls[0];
  expect(payload).toMatchObject({model:VERSION.model,max_tokens:2400,
    tool_choice:{type:'tool',name:'submit_caption_places',disable_parallel_tool_use:true}});
  expect(payload.tools).toHaveLength(1);
  expect(payload.tools[0].input_schema).toMatchObject({type:'object',additionalProperties:false,required:['places'],
    properties:{places:{type:'array',maxItems:40,items:{additionalProperties:false,required:['name'],
      properties:{name:{maxLength:300},address:{maxLength:500}}}}}});
  expect(Object.keys(payload.tools[0].input_schema.properties.places.items.properties).sort())
    .toEqual(['address','city','country','handle','name','source']);
  expect(transport).toMatchObject({timeout:30000,maxRetries:0});
  expect(transport.signal).toBeInstanceOf(AbortSignal);
  const observation=require('../lib/providerRuntime').withProvider.mock.calls[0][3];
  expect(observation.descriptor.maxInputTokens).toBe(Buffer.byteLength(JSON.stringify(payload.messages))
    +Buffer.byteLength(JSON.stringify({tools:payload.tools,tool_choice:payload.tool_choice}))+1024);
  expect(observation.descriptor.maxOutputTokens).toBe(2400);
  expect(JSON.stringify(observation)).not.toContain('PRIVATE');
});

test.each([
  null,{}, {name:''}, {name:'bad',city:42}, {name:'bad',address:['PRIVATE']}, {name:'bad',source:'vision'},
  {name:'bad',confirmedPlaceId:'PRIVATE'}, {name:'bad',requiresSelection:false}, {name:'bad',verified:true},
  {name:'bad',verification:{matched:true}}, {name:'bad',geometry:{location:{lat:1,lng:1}}},
  {name:'bad',evidenceRefs:[{evidenceId:'PRIVATE'}]}, {name:'bad',provenance:'caption'},
  {name:'bad',handle:'x'.repeat(501)}, {name:'x'.repeat(301)},
])('retains independent multilingual candidate and marks rejected sibling %#',async bad=>{
  const result=await request({places:[bad,sushi],count:999});
  expect(result).toEqual({places:[sushi],count:1,incomplete:true});
  expect(cache.setCache).toHaveBeenCalledWith(expect.any(String),result,300);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  const config=runSharedAiOperation.mock.calls[0][0];
  const otherProcess=createSharedAiOperations({firestore,cache});
  const work=jest.fn();
  await expect(otherProcess.runSharedAiOperation(config,work)).resolves.toEqual(result);
  expect(work).not.toHaveBeenCalled();
  const record=firestore.read(COLLECTION,identity(config).key+'_1');
  expect(record.result).toEqual(result);
  expect(JSON.stringify(record.result)).not.toContain('PRIVATE');
});

test('does not erase or collapse valid multilingual names, accents or distinct branches',async()=>{
  const places=[sushi,{name:'sun kwai heung 新桂香燒臘',city:'Chai Wan',address:'345 Chai Wan Road',source:'caption'},
    {name:'Txispa',source:'handle',handle:'txispa_restaurant'},
    {name:'Phở Gia Truyền',city:'Hà Nội'}, {name:'Phở Gia Truyền',city:'Hồ Chí Minh City'}];
  expect(await request({places,count:-1})).toEqual({places,count:places.length});
  expect(cache.setCache).toHaveBeenCalledWith(expect.any(String),{places,count:places.length},86400);
});

test.each([
  {places:[null,{name:'bad',confirmedPlaceId:'PRIVATE'}]},
  {places:[{name:''},{name:'bad',city:42}],count:0},
  {places:[{name:'bad',source:'vision'}]},
])('all invalid candidates fail; never cache successful empty %#',async value=>{
  await expectInvalid(tool(value),'schema_places');
});

test.each([
  {},{count:0},{places:null},{places:{}},{places:'PRIVATE'},
  {places:[sushi],verified:true},{places:[sushi],confirmedPlaceId:'PRIVATE'},
  {places:[],incomplete:true},{places:[],incomplete:false},{places:[sushi],incomplete:true},
  {places:Array.from({length:41},()=>sushi)},
])('malformed root or oversize list is rejected before salvage %#',async value=>{
  await expectInvalid(tool(value),'schema_places');
});

test('legitimate empty declaration remains a short-lived success',async()=>{
  expect(await request({places:[],count:'untrusted and ignored'})).toEqual({places:[],count:0});
  expect(cache.setCache).toHaveBeenCalledWith(expect.any(String),{places:[],count:0},300);
});

test('accepts forty bounded candidates but does not silently truncate the forty-first',async()=>{
  const places=Array.from({length:40},(_,i)=>({name:`Venue ${i}`}));
  expect(await request({places})).toEqual({places,count:40});
});

test.each([
  ['truncated',()=>({...tool(),stop_reason:'max_tokens'}),'stop_max_tokens'],
  ['refused',()=>({...tool(),stop_reason:'refusal'}),'stop_refusal'],
  ['unknown stop',()=>({...tool(),stop_reason:'pause_turn'}),'stop_other'],
  ['wrong stop for declaration',()=>({...tool(),stop_reason:'end_turn'}),'envelope'],
  ['refusal block',()=>({stop_reason:'tool_use',content:[{type:'refusal',text:'PRIVATE'}]}),'refusal'],
  ['empty blocks',()=>({...tool(),content:[]}),'tool_blocks'],
  ['no blocks',()=>({...tool(),content:null}),'tool_blocks'],
  ['parallel declarations',()=>({...tool(),content:[...tool().content,...tool().content]}),'tool_blocks'],
  ['prose plus declaration',()=>({...tool(),content:[{type:'text',text:'PRIVATE'},...tool().content]}),'tool_blocks'],
  ['refusal plus declaration',()=>({...tool(),content:[...tool().content,{type:'refusal',text:'PRIVATE'}]}),'tool_blocks'],
  ['wrong tool',()=>({...tool(),content:[{...tool().content[0],name:'save_pin'}]}),'envelope'],
  ['empty id',()=>({...tool(),content:[{...tool().content[0],id:''}]}),'envelope'],
  ['long id',()=>({...tool(),content:[{...tool().content[0],id:'x'.repeat(201)}]}),'envelope'],
  ['array input',()=>tool([]),'envelope'],
  ['string input',()=>tool('{"places":[]}'),'envelope'],
  ['extra metadata',()=>({...tool(),content:[{...tool().content[0],verified:true}]}),'tool_metadata'],
  ['server tool',()=>({...tool(),content:[{...tool().content[0],caller:{type:'code_execution_20260120'}}]}),'tool_caller'],
  ['null caller',()=>({...tool(),content:[{...tool().content[0],caller:null}]}),'tool_caller'],
  ['caller extras',()=>({...tool(),content:[{...tool().content[0],caller:{type:'direct',verified:true}}]}),'tool_caller'],
  ['toolset',()=>({...tool(),content:[{...tool().content[0],toolset_name:'PRIVATE'}]}),'tool_metadata'],
])('strict declaration envelope rejects %s',async(_label,message,reason)=>{
  await expectInvalid(message(),reason);
});

test('older direct-tool envelopes may omit caller; neither parser weakens the other',async()=>{
  const message=tool();delete message.content[0].caller;
  anthropic.messages.create.mockResolvedValue(message);
  expect(await aiExtractPlaces(input,options)).toEqual({places:[sushi],count:1});
  expect(()=>parseResponse(message)).toThrow(expect.objectContaining({aiResponseReason:'stop_other'}));
  const legacy={stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({places:[sushi]})}]};
  expect(parseCaptionResponse(legacy)).toEqual(parseResponse(legacy));
});

test.each([
  ['Unicode byte bound',()=>({places:[sushi],count:'東京'.repeat(MAX_RESPONSE_BYTES/2)}),'response_too_large'],
  ['deep data',()=>({places:[sushi],count:Array.from({length:17}).reduce(value=>[value],null)}),'format_depth'],
  ['nonfinite data',()=>({places:[sushi],count:Infinity}),'envelope'],
  ['custom object',()=>({places:[sushi],count:new Date()}),'envelope'],
  ['sparse array',()=>({places:new Array(1)}),'envelope'],
  ['sparse with nonindex key',()=>({places:Object.assign(new Array(1),{foo:sushi})}),'envelope'],
  ['symbol data',()=>({places:[sushi],[Symbol('PRIVATE')]:true}),'envelope'],
])('input bounds reject %s before candidate recovery',async(_label,make,reason)=>{
  await expectInvalid(tool(make()),reason);
});

test('accessors and toJSON cannot inject trusted data or execute during validation',async()=>{
  const getter=jest.fn(()=>[sushi]);
  const value=Object.defineProperty({},'places',{get:getter,enumerable:true});
  await expectInvalid(tool(value),'envelope');
  expect(getter).not.toHaveBeenCalled();
  const toJSON=jest.fn(()=>({places:[sushi]}));
  expect(()=>parseCaptionResponse(tool({places:[],toJSON}))).toThrow();
  expect(toJSON).not.toHaveBeenCalled();
});

test('prototype injection is discarded as a whole candidate, never copied into output',async()=>{
  const malicious=JSON.parse('{"name":"PRIVATE","__proto__":{"verified":true}}');
  expect(await request({places:[malicious,sushi]})).toEqual({places:[sushi],count:1,incomplete:true});
  expect({}.verified).toBeUndefined();
});

test.each([
  {places:[],count:0,incomplete:true},{places:[sushi],count:1,incomplete:false},
  {places:[sushi],count:1,incomplete:'true'},{places:[sushi],count:2,incomplete:true},
  {places:[{...sushi,confirmedPlaceId:'PRIVATE'}],count:1},
  {places:[{...sushi,name:'  uncanonical  '}],count:1},
  {places:[sushi],count:1,verified:true},
  {places:Array(40).fill(sushi),count:40,incomplete:true},
])('stored malformed results fail rather than being normalized %#',async bad=>{
  await aiExtractPlaces(input,options);
  const config=runSharedAiOperation.mock.calls[0][0];
  firestore.read(COLLECTION,identity(config).key+'_1').result=bad;
  const remote=createSharedAiOperations({firestore,cache});
  const work=jest.fn();
  await expect(remote.runSharedAiOperation(config,work)).rejects.toMatchObject({code:'invalid_response'});
  expect(work).not.toHaveBeenCalled();
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});

test('local caption identity change avoids old durable failures and does not alter verifier identity',async()=>{
  await aiExtractPlaces(input,options);
  const config=runSharedAiOperation.mock.calls[0][0];
  const old={...config,promptVersion:VERSION.prompt+':places:2',schemaVersion:VERSION.schema,optionsVersion:'bounded-ai-2'};
  expect(config.promptVersion).toBe(old.promptVersion+':'+CAPTION_OUTPUT_VERSION);
  expect(identity(config).key).not.toBe(identity(old).key);
  firestore.reset();
  const prior=createSharedAiOperations({firestore,cache});
  await expect(prior.runSharedAiOperation(old,async()=>{throw new EngineError('invalid_response',{stage:'ai',provider:'anthropic'});}))
    .rejects.toMatchObject({code:'invalid_response'});
  anthropic.messages.create.mockClear();
  expect(await aiExtractPlaces(input,options)).toEqual({places:[sushi],count:1});
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(firestore.read(COLLECTION,identity(old).key+'_1').state).toBe('failed');
  anthropic.messages.create.mockResolvedValue({stop_reason:'end_turn',content:[{type:'text',text:'{"match":true,"betterQuery":null}'}]});
  await aiVerifyPlace(input,'Sushi','Nagoya',[],options);
  const verify=runSharedAiOperation.mock.calls.at(-1)[0];
  expect(verify).toMatchObject({promptVersion:VERSION.prompt+':verify-place:2',schemaVersion:VERSION.schema,optionsVersion:'bounded-ai-2'});
  expect(anthropic.messages.create.mock.calls.at(-1)[0].tools).toBeUndefined();
});

test('structured responses retain scope isolation, coalescing and private unscoped calls',async()=>{
  const result=await Promise.all([
    aiExtractPlaces(input,options),aiExtractPlaces(input,options),
    aiExtractPlaces(input,{scope:'user:other'}),aiExtractPlaces(input,{scope:SERVER_PUBLIC_SCOPE}),
  ]);
  expect(result).toEqual(Array(4).fill({places:[sushi],count:1}));
  expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
  cache.getCached.mockClear();cache.setCache.mockClear();
  await aiExtractPlaces(input);
  expect(cache.getCached).not.toHaveBeenCalled();expect(cache.setCache).not.toHaveBeenCalled();
});
