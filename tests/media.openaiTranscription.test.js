const {createHash}=require('crypto');
const {createOpenAITranscription,MODEL}=require('../lib/media/providers/openaiTranscription');
const bytes=Buffer.from('RIFF1234WAVEtest'), hash=createHash('sha256').update(bytes).digest('hex');
const input={audioBytes:bytes,audioSha256:hash,startMs:19000,endMs:39000};
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
function setup(value){const fetchImpl=jest.fn().mockResolvedValue(value);return {fetchImpl,adapter:createOpenAITranscription({fetchImpl,getApiKey:()=> 'test-only-not-a-key'})};}

test('uses pinned speech model, JSON, native language; no retry/timestamp/translation request',async()=>{
  const {adapter,fetchImpl}=setup(response({text:'鯛寿司 and ngâm CAFE',usage:{type:'tokens',input_tokens:25,input_token_details:{audio_tokens:24,text_tokens:1},output_tokens:8,total_tokens:33}}));
  const result=await adapter.transcribeChunk(input);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url,request]=fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  expect(request).toMatchObject({method:'POST',redirect:'error'});
  expect(request.body.get('model')).toBe(MODEL);expect(request.body.get('response_format')).toBe('json');
  for(const key of ['timestamp_granularities','language','prompt']) expect(request.body.has(key)).toBe(false);
  expect(Buffer.from(await request.body.get('file').arrayBuffer())).toEqual(bytes);
  expect(result).toMatchObject({language:null,text:'鯛寿司 and ngâm CAFE',segments:[{text:'鯛寿司 and ngâm CAFE',startMs:19000,endMs:39000,timing:'chunk'}],usage:{input_token_details:{audio_tokens:24,text_tokens:1},submitted_seconds:20}});
});
test('valid no-speech text is empty evidence; missing usage remains unknown',async()=>{
  const {adapter}=setup(response({text:''}));
  expect(await adapter.transcribeChunk(input)).toEqual({text:'',language:null,segments:[],usage:null});
});
test.each([[401,'access_blocked'],[413,'input_too_large'],[429,'rate_limited'],[404,'invalid_response'],[422,'invalid_response'],[500,'dependency_error']])('HTTP %i normalized with no retries',async(status,code)=>{
  const {adapter,fetchImpl}=setup(response({error:{message:'private provider body'}},status,{'retry-after':'75'}));
  await expect(adapter.transcribeChunk(input)).rejects.toMatchObject({code,provider:'openai',retryAfterSeconds:75});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each([{}, {text:12}, {text:'a'.repeat(16001)}])('malformed success is failure, not no-place: %j',async data=>{
  const {adapter}=setup(response(data));await expect(adapter.transcribeChunk(input)).rejects.toMatchObject({code:'invalid_response'});
});
test('malformed transcript preserves reported physical usage for failed-call accounting',async()=>{
  const usage={type:'tokens',input_tokens:25,output_tokens:8,total_tokens:33,input_token_details:{audio_tokens:24,text_tokens:1},private:'never copied'};
  const {adapter,fetchImpl}=setup(response({text:12,usage}));let failure;
  try{await adapter.transcribeChunk(input);}catch(error){failure=error;}
  expect(failure).toMatchObject({code:'invalid_response',usage:{input_tokens:25,output_tokens:8,input_token_details:{audio_tokens:24,text_tokens:1}}});
  expect(failure.usage.private).toBeUndefined();
  expect(require('../lib/engineBudgetPolicy').usageFrom(null,failure,'openai')).toMatchObject({input:25,output:8,audioInput:24,textInput:1});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('model mismatch, invalid hash and expired deadline are refused before sending',async()=>{
  const {adapter,fetchImpl}=setup(response({text:'Cafe'}));
  await expect(adapter.transcribeChunk({...input,model:'gpt-4o-transcribe'})).rejects.toMatchObject({code:'invalid_response'});
  await expect(adapter.transcribeChunk({...input,audioSha256:'a'.repeat(64)})).rejects.toMatchObject({code:'invalid_response'});
  await expect(adapter.transcribeChunk({...input,deadline:Date.now()-1})).rejects.toMatchObject({code:'dependency_timeout'});
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('abort while network in flight stays cancelled and never retries',async()=>{
  const controller=new AbortController();let sent;
  const started=new Promise(r=>{sent=r;});
  const fetchImpl=jest.fn((_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason));sent();}));
  const adapter=createOpenAITranscription({fetchImpl,getApiKey:()=> 'test-only'});
  const pending=adapter.transcribeChunk({...input,signal:controller.signal});await started;controller.abort();
  await expect(pending).rejects.toMatchObject({code:'attempt_stopped'});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('request deadline aborts the fetch and is a timeout',async()=>{
  const fetchImpl=jest.fn((_url,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason))));
  const adapter=createOpenAITranscription({fetchImpl,getApiKey:()=> 'test-only'});
  await expect(adapter.transcribeChunk({...input,deadline:Date.now()+20})).rejects.toMatchObject({code:'dependency_timeout'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('response stream is bounded even without content-length',async()=>{
  const {adapter}=setup(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(70000));controller.close();}})));
  await expect(adapter.transcribeChunk(input)).rejects.toMatchObject({code:'invalid_response'});
});
