jest.mock('../lib/anthropic',()=>({anthropic:{messages:{create:jest.fn()}}}));
jest.mock('../lib/cache',()=>({getCached:jest.fn(),setCache:jest.fn()}));
jest.mock('../lib/providerRuntime',()=>({withProvider:jest.fn((_p,work)=>work())}));
const {anthropic}=require('../lib/anthropic');
const {getCached,setCache}=require('../lib/cache');
const {aiExtractPlaces,aiVerifyPlace,cacheKey}=require('../enrich/ai');
const response=text=>({stop_reason:'end_turn',content:[{type:'text',text}]});
beforeEach(()=>{jest.clearAllMocks();getCached.mockResolvedValue(null);anthropic.messages.create.mockResolvedValue(response('{"places":[],"count":0}'));});
test('shared text, all tag origins, display name and full caption are sent to AI',async()=>{
  const input={description:'x'.repeat(1300)+' Tai Sushi',shareText:'Kyoto',accountTags:[{handle:'ramenofficial',displayName:'Ramen Kitchen',origin:'post_tag'}],collaborators:['cafeab']};
  await aiExtractPlaces(input,{scope:'user:a'});
  const prompt=anthropic.messages.create.mock.calls[0][0].messages[0].content;
  for(const text of ['Tai Sushi','Kyoto','ramenofficial','Ramen Kitchen','post_tag','cafeab'])expect(prompt).toContain(text);
});
test('scope and every prompt field participate in cache identity',()=>{
  const base={description:'hello'};
  expect(cacheKey('places',base,'user:a')).not.toBe(cacheKey('places',base,'user:b'));
  for(const field of ['shareText','accountTags','collaborators','hashtags','uploader','subtitles'])expect(cacheKey('places',base,'public')).not.toBe(cacheKey('places',{...base,[field]:'changed'},'public'));
});
test('valid empty uses a short TTL and explicit retry bypasses it',async()=>{
  await aiExtractPlaces({description:'hello'},{scope:'user:a'});
  expect(setCache).toHaveBeenCalledWith(expect.any(String),{places:[],count:0},300);
  getCached.mockClear();
  await aiExtractPlaces({description:'hello'},{scope:'user:a',bypassCache:true});
  expect(getCached).not.toHaveBeenCalled();
});
test('unscoped calls never share private context through persistent cache',async()=>{
  await aiExtractPlaces({description:'private notes'});
  expect(getCached).not.toHaveBeenCalled();expect(setCache).not.toHaveBeenCalled();
});
test.each(['max_tokens','refusal','tool_use'])('%s is a failure, not a cached empty',async stop_reason=>{
  anthropic.messages.create.mockResolvedValue({...response('{"places":[]}'),stop_reason});
  await expect(aiExtractPlaces({title:'post'},{scope:'public'})).rejects.toMatchObject({code:'invalid_response'});
  expect(setCache).not.toHaveBeenCalled();
});
test('provider error remains a typed failure and verifier does not claim a match',async()=>{
  anthropic.messages.create.mockRejectedValue(Object.assign(new Error('quota'),{status:429}));
  await expect(aiExtractPlaces({title:'post'})).rejects.toMatchObject({code:'rate_limited'});
  expect(await aiVerifyPlace({title:'post'},'Cafe','Kyoto',[])).toMatchObject({match:null});
});

test.each(['confirmedPlaceId','requiresSelection','vision'])('model output cannot assert trusted %s evidence',async field=>{
  const place=field==='vision'?{name:'Cafe',source:'vision'}:{name:'Cafe',source:'caption',[field]:field==='requiresSelection'?false:'trusted-id'};
  anthropic.messages.create.mockResolvedValue(response(JSON.stringify({places:[place]})));
  await expect(aiExtractPlaces({description:'@cafe'},{scope:'public'})).rejects.toMatchObject({code:'invalid_response'});
  expect(setCache).not.toHaveBeenCalled();
});

test('concurrent identical extraction, including single-place projection, calls the provider once',async()=>{
  const {aiExtractSingle}=require('../enrich/ai');
  const calls=[aiExtractPlaces({title:'coalesced'},{scope:'user:coalesced'}),aiExtractPlaces({title:'coalesced'},{scope:'user:coalesced'}),aiExtractSingle({title:'coalesced'},{scope:'user:coalesced'})];
  expect(await Promise.all(calls)).toEqual([{places:[],count:0},{places:[],count:0},{place:null}]);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
});
test('verification accepts caller scope and keys complete candidate evidence',async()=>{
  anthropic.messages.create.mockResolvedValue(response('{"match":true,"betterQuery":null}'));
  await Promise.all([
    aiVerifyPlace({title:'Cafe'},'Cafe','Kyoto',['cafe'],{scope:'user:a'}),
    aiVerifyPlace({title:'Cafe'},'Cafe','Kyoto',['cafe'],{scope:'user:a'}),
    aiVerifyPlace({title:'Cafe'},'Cafe','Tokyo',['cafe'],{scope:'user:a'}),
    aiVerifyPlace({title:'Cafe'},'Cafe','Kyoto',['cafe'],{scope:'user:b'}),
  ]);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
});
test('verification preserves rate limit failure rather than successful null match',async()=>{
  anthropic.messages.create.mockRejectedValue(Object.assign(Error('quota'),{status:429}));
  expect(await aiVerifyPlace({title:'Cafe'},'Cafe','Kyoto',[],{scope:'user:a'})).toMatchObject({failure:{code:'rate_limited'}});
  expect(setCache).not.toHaveBeenCalled();
});
test('region helper shares complete normalized evidence and rejects incomplete provider output',async()=>{
  const {aiInferPlaceRegions}=require('../enrich/ai');
  const input={places:[{name:'Cafe',url:'https://example.com/cafe'}],listName:'Tokyo',siblingPlaces:['Tokyo Tower']};
  anthropic.messages.create.mockResolvedValue(response('{"results":[{"name":"Cafe","city":"Tokyo","country":"Japan","confidence":"high"}]}'));
  const result=await Promise.all([aiInferPlaceRegions(input,{scope:'user:a'}),aiInferPlaceRegions(input,{scope:'user:a'})]);
  expect(result[0].results[0].city).toBe('Tokyo');expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  anthropic.messages.create.mockResolvedValue(response('{"results":[]}'));
  await expect(aiInferPlaceRegions(input,{scope:'user:a',bypassCache:true})).rejects.toMatchObject({code:'invalid_response'});
});

test('text requests provide bounded observation descriptors without raw prompt data',async()=>{
  const {withProvider}=require('../lib/providerRuntime');
  await aiExtractPlaces({title:'京都 ☕'},{scope:'user:observation'});
  const descriptor=withProvider.mock.calls[0][3];
  const request=anthropic.messages.create.mock.calls[0][0];
  expect(descriptor).toMatchObject({stage:'ai',rateKey:'haiku',descriptor:{model:request.model,maxImageTokens:0,maxOutputTokens:2400,cacheEnabled:false}});
  expect(descriptor.descriptor.maxInputTokens).toBe(Buffer.byteLength(JSON.stringify(request.messages),'utf8')+1024);
  expect(JSON.stringify(descriptor)).not.toContain('京都');
});
