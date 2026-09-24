jest.mock('../lib/cache',()=>({redis:null}));
jest.mock('../lib/firestore',()=>({firestore:null}));
const {createHash}=require('crypto');
const {FakeFirestore}=require('./helpers/fakeFirestore');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const {COLLECTION}=require('../lib/sharedAiStore');
const {identity}=require('../lib/sharedAiIdentity');
const {createTranscriptionService,sharedEvidenceOptions}=require('../lib/media/transcriptionService');
const {createVideoVision}=require('../lib/media/videoVision');
const {createEvidenceFusion}=require('../lib/media/fuseEvidence');
const {createPendingGenerationResolver}=require('../lib/media/pendingOperation');
const {EngineError}=require('../lib/engineError');
const jobContext=require('../lib/jobContext');
const {RECOVERY}=require('../lib/media/analysisRecovery');
const gate=()=>{let release;return {promise:new Promise(r=>{release=r;}),release:()=>release()};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(kind,override={}) {
  const db=new FakeFirestore();db.strictReadOrder=true;
  const operations=createSharedAiOperations({firestore:db,limits:{pollMs:5,subscriptionLeaseMs:100}});
  const sharedOperation=jest.fn((o,work)=>operations.runSharedAiOperation({...o,...override},work));
  const held=gate(),started=gate();let mode='hang';
  const physical=jest.fn(async()=>{
    started.release();
    if(mode==='hang')await held.promise;
    if(mode==='fail')throw new EngineError('dependency_timeout');
    if(kind==='asr_chunk')return {text:'Cafe'};
    return {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(kind==='video_vision'?{places:[],observations:[]}:{places:[]})}]};
  });
  const providerCall=async(_provider,work)=>{await jobContext.current().sharedOperation.authorizeDispatch();return work();};
  const deps={sharedOperation,providerCall,createMessage:physical,generationResolver:createPendingGenerationResolver({firestore:db})};
  const input={mediaDigest:hash(Buffer.from('media')),durationMs:1000};
  let invoke;
  if(kind==='asr_chunk') {
    const adapter={id:'openai',model:'gpt-4o-mini-transcribe-2025-12-15',version:'deadline-test',transcribeChunk:physical};
    const service=createTranscriptionService({...deps,providers:{openai:adapter}});
    invoke=options=>service.transcribe({...input,chunks:[{audioBytes:Buffer.from('RIFF0000WAVEaudio'),startMs:0,endMs:1000}]},options);
  } else if(kind==='video_vision') {
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5w0AAAAASUVORK5CYII=','base64');
    invoke=options=>createVideoVision(deps)({...input,frames:[{bytes,digest:hash(bytes),width:1,height:1,timestampMs:100}]},options);
  } else invoke=options=>createEvidenceFusion(deps)({...input,textEvidence:[{evidenceId:'audio:1',modality:'transcript',text:'Cafe'}]},options);
  const run=(retryOperations,retryKind='analysis')=>{
    // Only the server's explicit-retry path persists these records; verify
    // actual current/parent jobs through the production read-only resolver.
    if(retryOperations) {
      db.seed('enrichmentJobs','parent',{userId:'u',url:'https://example.test/media',status:'failed',analysisRecovery:RECOVERY,mediaRetryOperations:retryOperations});
      db.seed('enrichmentJobs','retry',{userId:'u',url:'https://example.test/media',status:'processing',retryOf:'parent',...(retryKind?{retryKind}:{})});
    }
    return jobContext.run({jobId:'retry',userId:'u',deadline:Date.now()+5000},
      ()=>invoke({scope:SERVER_PUBLIC_SCOPE,...(retryOperations?{retryOperations}:{})})).catch(error=>error);
  };
  return {db,operations,sharedOperation,physical,run,held,started,setMode:value=>{mode=value;},key:()=>identity(sharedOperation.mock.calls[0][0]).key};
}

test.each(['asr_chunk','video_vision','media_fusion'])('%s preserves a known terminal generation after a local operation deadline, without automatic dispatch',async kind=>{
  // A longer caller wait makes the producer's own timeout/publication observable.
  const f=fixture(kind,{timeoutMs:30,waitMs:1000});
  try {
    const first=await f.run();
    expect(first.retryOperations).toEqual([{kind,retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:1}]);
    expect(['failed','uncertain']).toContain(f.db.read(COLLECTION,`${f.key()}_1`).state);
    f.setMode('success');
    const unchanged=await f.run();
    expect(unchanged.retryOperations).toEqual(first.retryOperations);
    expect(f.physical).toHaveBeenCalledTimes(1);
    const explicit=await f.run(first.retryOperations);
    expect(explicit).not.toBeInstanceOf(Error);
    expect(explicit.retryOperations || []).toEqual([]);
    await f.run(first.retryOperations);
    expect(f.physical).toHaveBeenCalledTimes(2);
    expect(f.sharedOperation.mock.calls.every(([o])=>o.bypassCache===undefined)).toBe(true);
  } finally {f.held.release();}
});

test.each(['asr_chunk','video_vision','media_fusion'])('%s pending timeout resolves durable failure on the first explicit retry, never automatically',async kind=>{
  const f=fixture(kind,{timeoutMs:1000,waitMs:30});
  const publishing=gate(),publish=gate();let once=true;
  const transaction=f.db.runTransaction.bind(f.db);
  f.db.runTransaction=fn=>transaction(async tx=>{
    const writes=[];
    const result=await fn({...tx,set:(ref,value,options)=>{
      if(once && ['failed','uncertain'].includes(value.state))writes.push([ref,value,options]);
      else tx.set(ref,value,options);
    }});
    if(writes.length) {once=false;publishing.release();await publish.promise;for(const args of writes)tx.set(...args);}
    return result;
  });
  f.setMode('fail');
  const pending=f.run();
  try {
    await publishing.promise;
    await wait(60); // Caller wait has elapsed; terminal write is still held.
    expect(f.db.read(COLLECTION,`${f.key()}_1`).state).toBe('running');
    publish.release();
    const first=await pending;
    expect(first.retryOperations).toEqual([{kind,retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:null}]);
    expect(f.physical).toHaveBeenCalledTimes(1);
    f.setMode('success');
    const retry=await f.run(first.retryOperations);
    expect(retry).not.toBeInstanceOf(Error);
    expect(retry.retryOperations || []).toEqual([]);
    expect(f.physical).toHaveBeenCalledTimes(2);
    await f.run(first.retryOperations);
    expect(f.physical).toHaveBeenCalledTimes(2); // Completed generation is reused.
  } finally {publish.release();f.held.release();await pending;}
});

test.each(['asr_chunk','video_vision','media_fusion'])('%s preclaim outage can be explicitly retried once without inventing generation authority',async kind=>{
  const f=fixture(kind,{timeoutMs:1000,waitMs:1000});
  const transaction=f.db.runTransaction.bind(f.db);let unavailable=true;
  f.db.runTransaction=fn=>{
    if(unavailable)throw new EngineError('dependency_error',{provider:'firestore'});
    return transaction(fn);
  };
  const first=await f.run();
  expect(first.retryOperations).toEqual([{kind,retryKey:expect.stringMatching(/^[a-f0-9]{64}$/),generation:null}]);
  expect(f.physical).not.toHaveBeenCalled();expect(f.db.read(COLLECTION,f.key())).toBeUndefined();
  unavailable=false;f.setMode('success');
  const retry=await f.run(first.retryOperations,null); // Ordinary Retry for initial no-known-place failure.
  expect(retry).not.toBeInstanceOf(Error);expect(retry.retryOperations || []).toEqual([]);
  expect(f.physical).toHaveBeenCalledTimes(1);
  expect(f.sharedOperation.mock.calls.every(([o])=>o.retryGeneration===undefined && o.bypassCache===undefined)).toBe(true);
  await f.run(first.retryOperations,null);expect(f.physical).toHaveBeenCalledTimes(1);
});

test.each(['asr_chunk','video_vision','media_fusion'].flatMap(kind=>['success','fail'].map(end=>[kind,end])))
('%s pending retry joins running generation that ends in %s, never automatically starts a successor',async(kind,end)=>{
  const f=fixture(kind,{timeoutMs:1000,waitMs:1000});
  const first=f.run();await f.started.promise;
  const {retryKey}=sharedEvidenceOptions(f.sharedOperation.mock.calls[0][0]);
  const marker={kind,retryKey,generation:null};
  const joined=f.run([marker]);
  try {
    // Let the resolver read and subscribe while the provider remains held.
    await wait(10);expect(f.physical).toHaveBeenCalledTimes(1);
    f.setMode(end);f.held.release();
    const results=await Promise.all([first,joined]);
    if(end==='success')expect(results.every(r=>!(r instanceof Error) && !(r.retryOperations || []).length)).toBe(true);
    else for(const result of results)expect(result.retryOperations).toEqual([{...marker,generation:1}]);
    expect(f.physical).toHaveBeenCalledTimes(1);
    expect(f.sharedOperation.mock.calls.every(([o])=>o.retryGeneration===undefined && o.bypassCache===undefined)).toBe(true);
    expect(f.db.read(COLLECTION,f.key()).generation).toBe(1);
  } finally {f.held.release();await Promise.all([first,joined]);}
});
