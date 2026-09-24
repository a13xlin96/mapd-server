jest.mock('../lib/cache',()=>({redis:null}));
jest.mock('../lib/firestore',()=>({firestore:null}));
const {createHash}=require('crypto');
const {createTranscriptionService,SERVER_PUBLIC_SCOPE}=require('../lib/media/transcriptionService');
const {createSharedAiOperations}=require('../lib/sharedAiOperation');
const {EngineError}=require('../lib/engineError');
const jobContext=require('../lib/jobContext');
const digest=createHash('sha256').update('video').digest('hex');
const wav=text=>Buffer.from('RIFF0000WAVE'+text);
const chunk=(startMs=0,endMs=20000,text='audio')=>({audioBytes:wav(text),startMs,endMs});
function setup({adapter,sharedOperation}={}) {
  const cache=new Map();const writes=[];
  const operations=createSharedAiOperations({allowLocal:true,cache:{getCached:async k=>cache.get(k),setCache:async(k,v)=>{writes.push(v);cache.set(k,v);}}});
  const provider=adapter || {id:'openai',model:'gpt-4o-mini-transcribe-2025-12-15',version:'test-v1',
    transcribeChunk:jest.fn(async ({startMs,endMs})=>({text:'鯛寿司',language:null,segments:[{text:'鯛寿司',startMs,endMs,timing:'chunk'}],usage:{input_tokens:10}}))};
  const providerCall=jest.fn(async(_p,work)=>{await jobContext.current()?.sharedOperation?.authorizeDispatch();return work();});
  const run=jest.fn(sharedOperation || operations.runSharedAiOperation);
  const service=createTranscriptionService({providers:{[provider.id]:provider},sharedOperation:run,providerCall});
  const transcribe=(chunks=[chunk()],options={},extras={})=>service.transcribe({mediaDigest:digest,durationMs:20000,chunks,provider:provider.id,...extras},{scope:SERVER_PUBLIC_SCOPE,...options});
  return {provider,providerCall,transcribe,run,writes};
}
test('shared ASR has one physical call and strips billing from follower/cache evidence',async()=>{
  const {transcribe,provider,providerCall,writes,run}=setup();
  const [a,b]=await Promise.all([transcribe(),transcribe()]);
  expect(a).toEqual(b);expect(a.coverage).toEqual({status:'complete',intervals:[[0,20000]]});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);expect(providerCall).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(a)).not.toContain('usage');expect(JSON.stringify(writes)).not.toContain('usage');
  expect(run.mock.calls[0][0]).toMatchObject({kind:'asr_chunk',provider:'openai'});
  await transcribe();expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);
  expect(providerCall.mock.calls[0][3]).toMatchObject({rateKey:'openai_mini_transcribe',descriptor:{audioSeconds:20}});
});
test('fake second provider works with native timestamps and absent usage',async()=>{
  const adapter={id:'fake',model:'speech-v2',version:'native-v1',transcribeChunk:jest.fn(async()=>({text:'ngâm CAFE',language:'vi',segments:[{text:'ngâm CAFE',startMs:500,endMs:1500,timing:'native'}]}))};
  const {transcribe}=setup({adapter});const result=await transcribe();
  expect(result).toMatchObject({provider:'fake',model:'speech-v2',language:'vi',segments:[{timing:'native',startMs:500,endMs:1500}]});
});
test('changed bytes, model hint or private scope cannot collide',async()=>{
  const {transcribe,provider}=setup();
  await transcribe();await transcribe([chunk(0,20000,'different')]);await transcribe(undefined,{}, {languageHint:'ja'});
  await transcribe(undefined,{scope:'user:a'});await transcribe(undefined,{scope:'user:b'});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(5);
});
test('successful subtitle coverage prevents a paid audio request',async()=>{
  const {transcribe,provider}=setup();
  const result=await transcribe(undefined,{}, {subtitles:{language:'ja',segments:[{text:'鯛寿司',startMs:0,endMs:20000}],coverage:{status:'complete',intervals:[[0,20000]]}}});
  expect(provider.transcribeChunk).not.toHaveBeenCalled();expect(result.segments[0].origin).toBe('subtitle');
});
test('partial chunk failure retains successful evidence and is not full coverage',async()=>{
  const {transcribe,provider}=setup();provider.transcribeChunk.mockImplementation(async({startMs,endMs})=>{
    if(startMs>0)throw new EngineError('rate_limited',{provider:'openai'});
    return {text:'Tai Sushi',segments:[{text:'Tai Sushi',startMs,endMs,timing:'chunk'}]};
  });
  const result=await transcribe([chunk(),chunk(19000,39000,'b')],{}, {durationMs:39000});
  expect(result.coverage).toEqual({status:'partial',intervals:[[0,20000]],reason:'audio_chunk_failed'});
  expect(result.text).toBe('Tai Sushi');expect(result.failures[0].code).toBe('rate_limited');
});
test('explicit retry targets only failed input/version identity and never globally refreshes successes',async()=>{
  let failure=true;const failed=Object.assign(new EngineError('dependency_timeout'),{retryGeneration:7});
  const sharedOperation=jest.fn(async(options,work)=>{
    if(options.input.startMs>0 && failure)throw failed;
    return work();
  });
  const {transcribe,run}=setup({sharedOperation});
  const chunks=[chunk(),chunk(19000,39000,'b')];const result=await transcribe(chunks,{}, {durationMs:39000});
  expect(result.retryOperations).toEqual([{kind:'asr_chunk',retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:7}]);
  failure=false;run.mockClear();
  await transcribe(chunks,{retryOperations:result.retryOperations}, {durationMs:39000});
  expect(run.mock.calls[0][0].retryGeneration).toBeUndefined();expect(run.mock.calls[1][0].retryGeneration).toBe(7);
  expect(run.mock.calls.every(([o])=>o.bypassCache===undefined)).toBe(true);
  run.mockClear();await transcribe([chunk(19000,39000,'different')],{retryOperations:result.retryOperations},{durationMs:39000});
  expect(run.mock.calls[0][0].retryGeneration).toBeUndefined();
});
test('only two chunks run at once; all intervals retain offset coverage',async()=>{
  const {transcribe,provider}=setup();let running=0,max=0;
  provider.transcribeChunk.mockImplementation(async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,10));running--;return{text:'',segments:[]};});
  const chunks=[chunk(0,20000,'a'),chunk(19000,39000,'b'),chunk(38000,58000,'c'),chunk(57000,60000,'d')];
  const result=await transcribe(chunks,{}, {durationMs:60000});expect(max).toBe(2);expect(result.coverage.intervals).toEqual([[0,60000]]);
});
test('a cancelled follower cannot cancel live shared subscribers or mutate owned bytes',async()=>{
  const {transcribe,provider}=setup();let release,started;const startedPromise=new Promise(r=>{started=r;});
  const held=new Promise(r=>{release=r;});let received;
  provider.transcribeChunk.mockImplementation(async({audioBytes})=>{started();await held;received=audioBytes.toString();return{text:'Cafe'};});
  const input=chunk();const controller=new AbortController();
  const first=transcribe([input],{signal:controller.signal});
  const rejection=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  const second=transcribe([input]);await startedPromise;input.audioBytes.fill(0);controller.abort();release();
  await rejection;expect((await second).text).toBe('Cafe');expect(received).toBe('RIFF0000WAVEaudio');
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);
});
test('already cancelled work never dispatches',async()=>{
  const {transcribe,provider}=setup();const c=new AbortController();c.abort();
  await expect(transcribe(undefined,{signal:c.signal})).rejects.toMatchObject({code:'attempt_stopped'});
  expect(provider.transcribeChunk).not.toHaveBeenCalled();
});
test('invalid provider output and out-of-window native times are explicit failures',async()=>{
  const {transcribe,provider}=setup();provider.transcribeChunk.mockResolvedValue({text:'Cafe',segments:[{text:'Cafe',startMs:0,endMs:30000,timing:'native'}]});
  const result=await transcribe();expect(result.coverage.status).toBe('failed');expect(result.failures[0].code).toBe('invalid_response');
});
test('child deadline exposes already completed chunks; parent cancellation does not authorize partial consumption',async()=>{
  const {transcribe,provider}=setup();let release;
  const held=new Promise(r=>{release=r;});
  provider.transcribeChunk.mockImplementation(async({startMs,endMs})=>{
    if(startMs>0) await held;
    return {text:'Tai Sushi',segments:[{text:'Tai Sushi',startMs,endMs,timing:'chunk'}]};
  });
  const parent={deadline:Date.now()+5000,signal:new AbortController().signal};
  const controller=new AbortController();
  const context={deadline:Date.now()+40,signal:controller.signal,parentContext:parent};
  const timer=setTimeout(()=>controller.abort(new EngineError('dependency_timeout',{stage:'media'})),45);
  let error;
  try {await jobContext.run(context,()=>transcribe([chunk(),chunk(19000,39000,'b')],{}, {durationMs:39000}));}
  catch(e){error=e;} finally {release();clearTimeout(timer);}
  expect(error).toMatchObject({code:'dependency_timeout',partialResult:{text:'Tai Sushi',coverage:{status:'partial',intervals:[[0,20000]]}}});
  const stopped=new AbortController();stopped.abort();
  await expect(jobContext.run({...parent,signal:stopped.signal},()=>transcribe())).rejects.not.toHaveProperty('partialResult');
});
test('child deadline retains a known failed generation alongside successful partial ASR, without restarting chunks',async()=>{
  const child=new AbortController(),parent=new AbortController();let calls=0;
  const {transcribe,provider}=setup({sharedOperation:async(_options,work)=>{
    if(++calls===1)return work();
    child.abort(new EngineError('dependency_timeout',{stage:'media'}));
    throw Object.assign(new EngineError('dependency_timeout'),{retryGeneration:4});
  }});
  const context={deadline:Date.now()+5000,signal:child.signal,parentContext:{deadline:Date.now()+10000,signal:parent.signal}};
  let failure;
  try {await jobContext.run(context,()=>transcribe([chunk(),chunk(19000,39000,'second'),chunk(38000,58000,'third')],
    {policy:{audioConcurrency:1}},{durationMs:58000}));}catch(error){failure=error;}
  expect(failure).toMatchObject({code:'dependency_timeout',partialResult:{text:'鯛寿司',coverage:{status:'partial',intervals:[[0,20000]]},
    retryOperations:[{kind:'asr_chunk',retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:4}]}});
  expect(calls).toBe(2);expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);
});
test('ASR rejects stopped work but preserves the known shared generation on the error',async()=>{
  const {transcribe,provider}=setup({sharedOperation:async()=>{
    throw Object.assign(new EngineError('attempt_stopped',{stage:'coordination'}),{retryGeneration:3});
  }});
  await expect(transcribe()).rejects.toMatchObject({code:'attempt_stopped',
    retryOperations:[{kind:'asr_chunk',retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:3}]});
  expect(provider.transcribeChunk).not.toHaveBeenCalled();
});
test('deadline immediately after successful publication preserves evidence without a retry marker',async()=>{
  const child=new AbortController();
  const {transcribe,provider}=setup({sharedOperation:async(_options,work)=>{
    const result=await work();child.abort(new EngineError('dependency_timeout'));return result;
  }});
  let failure;
  try {
    await jobContext.run({deadline:Date.now()+5000,signal:child.signal,parentContext:{deadline:Date.now()+10000}},()=>
      transcribe([chunk(),chunk(19000,39000,'second')],{policy:{audioConcurrency:1}},{durationMs:39000}));
  }catch(error){failure=error;}
  expect(failure).toMatchObject({code:'dependency_timeout',retryOperations:[],partialResult:{text:'鯛寿司',failures:[],retryOperations:[],
    coverage:{status:'partial',intervals:[[0,20000]],reason:'audio_unread'}}});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);
});
test('real provider runtime records one physical OpenAI call, not follower charges',async()=>{
  const {withProvider}=require('../lib/providerRuntime');
  const metrics=require('../lib/engineMetrics');
  const operations=createSharedAiOperations({allowLocal:true});
  const adapter={id:'openai',model:'gpt-4o-mini-transcribe-2025-12-15',version:'physical-test',transcribeChunk:jest.fn(async()=>({text:'Tai Sushi',usage:{type:'tokens',input_tokens:25,output_tokens:8,input_token_details:{text_tokens:1,audio_tokens:24}}}))};
  const service=createTranscriptionService({providers:{openai:adapter},sharedOperation:operations.runSharedAiOperation,providerCall:withProvider});
  const reporter={providerCall:jest.fn(),stage:async(_stage,fn)=>fn()};
  const caller={deadline:Date.now()+1000,sharedMetrics:reporter,signal:new AbortController().signal};
  const input={mediaDigest:digest,durationMs:20000,chunks:[chunk()]};
  const results=await jobContext.run(caller,()=>Promise.all([service.transcribe(input,{scope:SERVER_PUBLIC_SCOPE}),service.transcribe(input,{scope:SERVER_PUBLIC_SCOPE})]));
  expect(adapter.transcribeChunk).toHaveBeenCalledTimes(1);expect(reporter.providerCall).toHaveBeenCalledTimes(1);
  expect(reporter.providerCall.mock.calls[0][0]).toMatchObject({provider:'openai',stage:'transcription',submittedAudioSeconds:20,tokens:{textInput:1,audioInput:24,output:8}});
  expect(results[0].text).toBe('Tai Sushi');expect(JSON.stringify(results)).not.toContain('usage');
});
test('malformed OpenAI transcription accounts reported physical usage once; failure followers never inherit billing',async()=>{
  const {withProvider}=require('../lib/providerRuntime');
  const {FakeFirestore}=require('./helpers/fakeFirestore');
  const {createOpenAITranscription}=require('../lib/media/providers/openaiTranscription');
  const db=new FakeFirestore(),operations=createSharedAiOperations({firestore:db,limits:{pollMs:5}});
  const fetchImpl=jest.fn(async()=>new Response(JSON.stringify({text:12,usage:{type:'tokens',input_tokens:25,output_tokens:8,
    input_token_details:{text_tokens:1,audio_tokens:24}}})));
  const adapter=createOpenAITranscription({fetchImpl,getApiKey:()=> 'test-fixture-only'});
  const service=createTranscriptionService({providers:{openai:adapter},sharedOperation:operations.runSharedAiOperation,providerCall:withProvider});
  const reporter={providerCall:jest.fn(),stage:async(_stage,work)=>work()};
  const caller={jobId:'fixture',userId:'fixture',deadline:Date.now()+5000,sharedMetrics:reporter};
  const run=()=>jobContext.run(caller,()=>service.transcribe({mediaDigest:digest,durationMs:20000,chunks:[chunk()]},{scope:SERVER_PUBLIC_SCOPE}));
  const results=await Promise.all([run(),run()]);results.push(await run());
  expect(results.every(r=>r.failures[0].code==='invalid_response')).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(reporter.providerCall).toHaveBeenCalledTimes(1);
  expect(reporter.providerCall.mock.calls[0][0]).toMatchObject({provider:'openai',outcome:'failed',tokens:{textInput:1,audioInput:24,output:8}});
  expect(JSON.stringify(results)).not.toContain('usage');
  for(const record of db.collections.get(require('../lib/sharedAiStore').COLLECTION).values())expect(JSON.stringify(record)).not.toContain('input_tokens');
});
test('recorded audio policy reduces concurrency, provider slots, timeout and success/empty TTL',async()=>{
  const {transcribe,provider,providerCall,run}=setup();let running=0,max=0;
  provider.transcribeChunk.mockImplementation(async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,5));running--;return{text:'Cafe'};});
  const policy={audioConcurrency:1,providerSlots:2,requestTimeoutMs:500,artifactTtlSeconds:120,manifestTtlSeconds:120};
  const start=Date.now();
  await transcribe([chunk(),chunk(19000,39000,'b')],{policy,requestTimeoutMs:1000},{durationMs:39000});
  expect(max).toBe(1);expect(providerCall.mock.calls.every(call=>call[2]===2)).toBe(true);
  for(const [options] of run.mock.calls) {
    expect(options).toMatchObject({timeoutMs:500,waitMs:500});
    expect(options.ttlSeconds({segments:[{text:'Cafe'}]})).toBe(120);
    expect(options.ttlSeconds({segments:[]})).toBe(120);
  }
  expect(provider.transcribeChunk.mock.calls[0][0].deadline).toBeLessThanOrEqual(start+520);
});
test('capacity and timeout changes reuse identical evidence; stricter artifact freshness does not reuse a longer-lived generation',async()=>{
  const {transcribe,provider,run}=setup();
  await transcribe();
  await transcribe(undefined,{policy:{audioConcurrency:1,providerSlots:1,requestTimeoutMs:1000}});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].input).toEqual(run.mock.calls[1][0].input);
  await transcribe(undefined,{policy:{artifactTtlSeconds:120,manifestTtlSeconds:120}});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[2][0].input.policy).toEqual({schemaVersion:1,policyVersion:'media-v1',artifactTtlSeconds:120});
});
test('invalid policy or chunks exceeding recorded audio bounds dispatch nothing',async()=>{
  const {transcribe,provider,run}=setup();
  for(const policy of [{audioConcurrency:3},{providerSlots:0},{requestTimeoutMs:20001},{audioChunkMs:10000}]) {
    await expect(transcribe(undefined,{policy})).rejects.toThrow();
  }
  await expect(transcribe(undefined,{policy:null})).rejects.toThrow();
  await expect(transcribe(undefined,{requestTimeoutMs:0})).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();expect(provider.transcribeChunk).not.toHaveBeenCalled();
});
