jest.mock('../lib/firestore',()=>({firestore:null,admin:null}));
const jobContext=require('../lib/jobContext');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {createVideoEvidence}=require('../lib/media/videoEvidence');
const {EngineError}=require('../lib/engineError');
const features=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true}}).forJob('u',undefined,['mediaRecoveryV1']);
const context=()=>({features,userId:'u',deadline:Date.now()+120000});
const frames=Array.from({length:16},(_,i)=>({digest:String(i),timestampMs:i*100,width:10,height:10}));
function fixture(overrides={}) {
 const deps={discover:jest.fn(async()=>({availability:'available'})),acquire:jest.fn(async()=>({contentDigest:'a'.repeat(64),bytes:500,dispose:jest.fn()})),
 probe:jest.fn(async()=>({durationMs:3000,hasAudio:true})),audio:jest.fn(async()=>[]),
 transcribe:jest.fn(async()=>({segments:[{text:'Cafe A',evidenceId:'a:1',startMs:0,endMs:3000,origin:'audio'}],coverage:{status:'complete',intervals:[[0,3000]]}})),
 frames:jest.fn(async()=>({frames,scannedFrames:18})),fusion:jest.fn(async()=>({places:[{name:'Cafe A',requiresSelection:true},{name:'Cafe B',requiresSelection:true}]})),
 vision:jest.fn(async()=>({places:[{name:'Cafe B',requiresSelection:true}]})),...overrides};
 return {deps,run:()=>jobContext.run(context(),()=>createVideoEvidence(deps)({url:'x',ogData:{},reason:'thin_text'}))};
}
test('feature off makes no new media calls',async()=>{
 const f=fixture();await jobContext.run({...context(),features:null},()=>createVideoEvidence(f.deps)({url:'x'}));
 expect(f.deps.discover).not.toHaveBeenCalled();
});
test('concurrent modalities preserve distinct venues and two bounded full-timeline frame batches',async()=>{
 const f=fixture(),result=await f.run();
 expect(result.incomplete).toBe(false);expect(result.places.map(p=>p.name).sort()).toEqual(['Cafe A','Cafe B']);
 expect(f.deps.vision).toHaveBeenCalledTimes(2);
 expect(f.deps.vision.mock.calls[0][0].frames.map(f=>f.timestampMs)).toEqual([0,200,400,600,800,1000,1200,1400]);
 expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test('optional visual timeout preserves successful spoken venue and marks coverage incomplete',async()=>{
 const f=fixture({vision:jest.fn(async()=>{throw new EngineError('dependency_timeout',{stage:'video_vision'});})});
 const result=await f.run();expect(result.places[0].name).toBe('Cafe A');expect(result.incomplete).toBe(true);
 expect(result.coverage.visual.status).toBe('failed');
});
test('source rejection cannot become successful empty analysis or invoke paid stages',async()=>{
 const f=fixture({discover:jest.fn(async()=>{throw new EngineError('rate_limited',{stage:'source'});})});
 const result=await f.run();expect(result.incomplete).toBe(true);expect(result.error.code).toBe('rate_limited');
 expect(f.deps.transcribe).not.toHaveBeenCalled();expect(f.deps.vision).not.toHaveBeenCalled();
});
test('cancelled parent cannot consume late evidence',async()=>{
 const abort=new AbortController();const f=fixture({fusion:jest.fn(async()=>{abort.abort();return {places:[{name:'late'}]};})});
 await expect(jobContext.run({...context(),signal:abort.signal},()=>createVideoEvidence(f.deps)({url:'x'}))).rejects.toMatchObject({code:'attempt_stopped'});
});
test('small frame sets use one paid call and public evidence remains shareable with private notes',async()=>{
 const f=fixture({frames:jest.fn(async()=>({frames:frames.slice(0,2)}))});
 await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',ogData:{shareText:'my private note',description:'my private note'}}));
 expect(f.deps.vision).toHaveBeenCalledTimes(1);
 expect(f.deps.vision.mock.calls[0][1].scope).toBe(require('../lib/sharedAiIdentity').SERVER_PUBLIC_SCOPE);
 expect(f.deps.transcribe.mock.calls[0][1].scope).toBe(require('../lib/sharedAiIdentity').SERVER_PUBLIC_SCOPE);
 expect(f.deps.fusion.mock.calls[0][1].scope).toBe('user:u');
});
test('fusion receives literal visual observations together with speech and baseline identity context',async()=>{
 const f=fixture({vision:jest.fn(async()=>({places:[],observations:[{evidenceId:'frame:a',quote:'寿司 太',region:[0,0,1,1]}]})),
  fusion:jest.fn(async input=>({places:[{name:'寿司 太',city:'Kyoto',requiresSelection:true}],contradictions:[{name:'Wrong Cafe',evidenceRefs:[{evidenceId:'a:1',quote:'not Wrong Cafe'}]}]}))});
 const result=await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',baselinePlaces:[{name:'Wrong Cafe'}]}));
 expect(f.deps.fusion).toHaveBeenCalledTimes(1);
 expect(f.deps.fusion.mock.calls[0][0].textEvidence).toEqual(expect.arrayContaining([expect.objectContaining({modality:'visual',text:'寿司 太'}),expect.objectContaining({modality:'transcript'})]));
 expect(f.deps.fusion.mock.calls[0][0].baselinePlaces).toEqual([expect.objectContaining({name:'Wrong Cafe'})]);
 expect(result.contradictions).toHaveLength(1);
});

function separateFixture(overrides={}) {
  const video={durationMs:3000,startMs:0,hasAudio:false,timelineOriginKnown:true,videoStreamIndex:0};
  const audioProbe={...video,hasAudio:true,audioStreamIndex:0,audioStartMs:0,
    separateAudio:{version:1,originMs:0,startMs:0,endMs:3090,sampleRate:48000,channels:2,transform:'copyts-video-origin-pcm16k-mono-v1'}};
  return fixture({discover:jest.fn(async()=>({availability:'available',audioRendition:{url:'https://cdn.example/private-audio'}})),
    acquireAudio:jest.fn(async()=>({contentDigest:'b'.repeat(64),bytes:100,dispose:jest.fn()})),
    probe:jest.fn(async input=>input.audioForVideo?audioProbe:video),...overrides});
}
test('video-only media acquires/probes separate audio once, uses joint identity for ASR and retains visual identity',async()=>{
  const f=separateFixture(),result=await f.run();
  expect(result.incomplete).toBe(false);expect(f.deps.acquire).toHaveBeenCalledTimes(1);expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
  const main=await f.deps.acquire.mock.results[0].value,track=await f.deps.acquireAudio.mock.results[0].value;
  expect(f.deps.probe).toHaveBeenCalledTimes(2);
  expect(f.deps.probe.mock.calls[1][0]).toMatchObject({media:track,audioForVideo:{hasAudio:false,durationMs:3000}});
  expect(f.deps.audio.mock.calls[0][0].media).toBe(track);
  expect(f.deps.transcribe.mock.calls[0][0].mediaDigest).not.toBe(main.contentDigest);
  expect(f.deps.transcribe.mock.calls[0][0].mediaDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.deps.vision.mock.calls[0][0].mediaDigest).toBe(main.contentDigest);
  expect(f.deps.fusion.mock.calls[0][0].mediaDigest).toBe(f.deps.transcribe.mock.calls[0][0].mediaDigest);
  expect(result.mediaDigest).toBe(f.deps.transcribe.mock.calls[0][0].mediaDigest);
  expect(f.deps.probe.mock.invocationCallOrder[1]).toBeLessThan(f.deps.audio.mock.invocationCallOrder[0]);
  expect(f.deps.probe.mock.invocationCallOrder[1]).toBeLessThan(f.deps.frames.mock.invocationCallOrder[0]);
  expect(f.deps.acquireAudio.mock.calls[0][0].deadline).toBeLessThanOrEqual(f.deps.acquire.mock.calls[0][0].deadline);
  expect(track.dispose).toHaveBeenCalledTimes(1);expect(main.dispose).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('private-audio');
});
test('muxed video never acquires separate audio even if metadata also offered it',async()=>{
  const f=separateFixture({probe:jest.fn(async()=>({durationMs:3000,hasAudio:true}))});
  await f.run();expect(f.deps.acquireAudio).not.toHaveBeenCalled();expect(f.deps.probe).toHaveBeenCalledTimes(1);
});
test.each(['rate_limited','access_blocked','dependency_timeout','invalid_response'])('separate audio %s leaves successful visual evidence, performs no ASR and never retries acquisition',async code=>{
  const f=separateFixture({acquireAudio:jest.fn(async()=>{throw new EngineError(code,{stage:'media_download'});}),
    vision:jest.fn(async()=>({places:[{name:'Visible cafe',requiresSelection:true}],observations:[{evidenceId:'frame:1',quote:'Visible cafe'}]})),
    fusion:jest.fn(async()=>({places:[],contradictions:[]}))});
  const result=await f.run();
  expect(result).toMatchObject({incomplete:true,coverage:{audio:{status:'failed',reason:code},visual:{status:'complete'}}});
  expect(result.places.map(p=>p.name)).toContain('Visible cafe');expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
  expect(f.deps.audio).not.toHaveBeenCalled();expect(f.deps.transcribe).not.toHaveBeenCalled();
  expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test('ambiguous audio probe retains frames and disposes both asset references',async()=>{
  const f=separateFixture({probe:jest.fn(async input=>{
    if(input.audioForVideo)throw new EngineError('invalid_response',{stage:'audio_timeline'});
    return {durationMs:3000,hasAudio:false};
  })});
  const result=await f.run();expect(result.coverage.audio.status).toBe('failed');expect(result.coverage.visual.status).toBe('complete');
  expect(f.deps.transcribe).not.toHaveBeenCalled();
  expect((await f.deps.acquireAudio.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
  expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test('parent cancellation cannot consume late separate audio and still disposes both references',async()=>{
  const abort=new AbortController(),f=separateFixture({audio:jest.fn(async()=>{abort.abort();return [];})});
  await expect(jobContext.run({...context(),signal:abort.signal},()=>createVideoEvidence(f.deps)({url:'x'}))).rejects.toMatchObject({code:'attempt_stopped'});
  expect((await f.deps.acquireAudio.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
  expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});

test('visual grounding omissions remain partial after a later clean batch and valid places survive',async()=>{
  const vision=jest.fn().mockResolvedValueOnce({places:[{name:'Cafe B',requiresSelection:true}],
    grounding:{omittedClaims:2,omittedCandidates:1}}).mockResolvedValueOnce({places:[{name:'Cafe C',requiresSelection:true}],
    grounding:{omittedClaims:0,omittedCandidates:0}});
  const writeManifest=jest.fn(),f=fixture({vision,writeManifest,probe:jest.fn(async()=>({durationMs:3000,hasAudio:false}))});
  const result=await f.run();
  expect(vision).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({incomplete:true,coverage:{visual:{status:'partial',reason:'literal_claims_omitted'}}});
  expect(result.places.map(p=>p.name)).toEqual(['Cafe B','Cafe C']);expect(writeManifest).not.toHaveBeenCalled();
});
test.each([false,true])('fusion grounding omissions preserve valid visual/fused places with text_bound priority=%s',async truncated=>{
  const writeManifest=jest.fn(),f=fixture({writeManifest,
    fusion:jest.fn(async()=>({places:[{name:'Cafe A',requiresSelection:true}],grounding:{omittedClaims:1,omittedCandidates:1}}))});
  const result=await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',ogData:truncated?{title:'x'.repeat(16001)}:{}}));
  expect(result).toMatchObject({incomplete:true,coverage:{fusion:{status:'partial',reason:truncated?'text_bound':'literal_claims_omitted'}}});
  expect(result.places.map(p=>p.name)).toEqual(['Cafe A','Cafe B']);expect(writeManifest).not.toHaveBeenCalled();
});
test('clean grounding summaries keep successful coverage complete',async()=>{
  const f=fixture({vision:jest.fn(async()=>({places:[{name:'Cafe B',requiresSelection:true}],grounding:{omittedClaims:0,omittedCandidates:0}})),
    fusion:jest.fn(async()=>({places:[{name:'Cafe A',requiresSelection:true}],grounding:{omittedClaims:0,omittedCandidates:0}}))});
  const result=await f.run();expect(result.incomplete).toBe(false);
  expect(result.coverage.visual.status).toBe('complete');expect(result.coverage.fusion.status).toBe('complete');
});

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
test('both frame batches start together, drain before fusion and preserve input ordering',async()=>{
  const first=deferred(),second=deferred(),started=deferred();
  const vision=jest.fn().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>{started.resolve();return second.promise;});
  const f=fixture({vision}),run=f.run();await started.promise;
  expect(vision).toHaveBeenCalledTimes(2);
  expect(vision.mock.calls[0][1].signal).toBe(vision.mock.calls[1][1].signal);
  expect(f.deps.fusion).not.toHaveBeenCalled();
  second.resolve({places:[{name:'Second'}],observations:[{evidenceId:'frame:second',quote:'Second'}]});
  await Promise.resolve();
  expect(f.deps.fusion).not.toHaveBeenCalled();
  expect((await f.deps.acquire.mock.results[0].value).dispose).not.toHaveBeenCalled();
  first.resolve({places:[{name:'First'}],observations:[{evidenceId:'frame:first',quote:'First'}]});
  await run;
  expect(f.deps.fusion.mock.calls[0][0].textEvidence.filter(e=>e.modality==='visual').map(e=>e.evidenceId))
    .toEqual(['frame:first:obs:0','frame:second:obs:1']);
  expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test.each([0,1])('a failed frame batch %s retains its successful sibling without retries or completed manifest',async failed=>{
  const first=deferred(),second=deferred(),started=deferred(),writeManifest=jest.fn();
  const vision=jest.fn().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>{started.resolve();return second.promise;});
  const f=fixture({vision,writeManifest,probe:jest.fn(async()=>({durationMs:3000,hasAudio:false}))}),run=f.run();
  await started.promise;
  const error=new EngineError('dependency_timeout',{stage:'video_vision'});
  error.retryOperations=[{kind:'video_vision',retryKey:'failed-batch'}];
  [first,second][failed].reject(error);
  await Promise.resolve();expect((await f.deps.acquire.mock.results[0].value).dispose).not.toHaveBeenCalled();
  [first,second][1-failed].resolve({places:[{name:'Visible cafe',requiresSelection:true}]});
  const result=await run;
  expect(result).toMatchObject({incomplete:true,coverage:{visual:{status:'partial',reason:'dependency_timeout'}},
    retryOperations:[{kind:'video_vision',retryKey:'failed-batch'}]});
  expect(result.places.map(p=>p.name)).toEqual(['Visible cafe']);
  expect(vision).toHaveBeenCalledTimes(2);expect(writeManifest).not.toHaveBeenCalled();
});
test('both failed batches are drained and retain both retry identities without claiming visual coverage',async()=>{
  const first=deferred(),second=deferred(),started=deferred();
  const vision=jest.fn().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>{started.resolve();return second.promise;});
  const f=fixture({vision}),run=f.run();await started.promise;
  for(const [i,operation] of [first,second].entries()) {
    const error=new EngineError('dependency_timeout',{stage:'video_vision'});
    error.retryOperations=[{kind:'video_vision',retryKey:String(i)}];operation.reject(error);
  }
  const result=await run;
  expect(result.coverage.visual).toMatchObject({status:'failed',reason:'dependency_timeout'});
  expect(result.retryOperations.map(r=>r.retryKey)).toEqual(['0','1']);
  expect(result.places.map(p=>p.name)).toContain('Cafe A');
});
test('cancelled parent cannot consume either late concurrent batch',async()=>{
  const first=deferred(),second=deferred(),started=deferred(),controller=new AbortController();
  const vision=jest.fn().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>{started.resolve();return second.promise;});
  const writeManifest=jest.fn(),f=fixture({vision,writeManifest});
  const run=jobContext.run({...context(),signal:controller.signal},()=>createVideoEvidence(f.deps)({url:'x'}));
  const rejected=expect(run).rejects.toMatchObject({code:'attempt_stopped'});
  await started.promise;controller.abort();
  expect(vision.mock.calls.every(([,options])=>options.signal.aborted)).toBe(true);
  first.resolve({places:[{name:'Late first'}]});second.resolve({places:[{name:'Late second'}]});
  await rejected;expect(writeManifest).not.toHaveBeenCalled();
  expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test.each([false,true])('coordinator emits only trusted source counters and records separate audio attempt=%s',async hasSeparate=>{
  const {mediaFromYtDlp,MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS}=require('../lib/media/mediaSource');
  const url='https://www.instagram.com/reel/SYNTHETIC/';
  const descriptor=mediaFromYtDlp({webpage_url:url,formats:[{url:'https://cdn.example/video.mp4',ext:'mp4',vcodec:'vp9',acodec:'none'},
    ...(hasSeparate?[{url:'https://cdn.example/audio.m4a?private=secret',ext:'m4a',vcodec:'none',acodec:'aac',protocol:'https'}]:[])]},url);
  const operation=jest.fn(),spy=jest.spyOn(require('../lib/engineMetrics'),'current').mockReturnValue({operation,
    recordStage:jest.fn(),stage:(_name,work)=>work()});
  try {
    const f=separateFixture({discover:jest.fn(async()=>descriptor)}),result=await f.run();
    expect(operation).toHaveBeenCalledWith('mediaSourceYtDlp',1);
    expect(operation).toHaveBeenCalledWith('mediaSourceAudioAttached',Number(hasSeparate));
    expect(operation).toHaveBeenCalledWith('mediaProbeHasAudio',0);
    const diagnostics=operation.mock.calls.filter(([name])=>MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS.includes(name));
    expect(diagnostics.every(([,value])=>Number.isSafeInteger(value) && value>=0 && value<=1000)).toBe(true);
    if(hasSeparate) {
      expect(operation).toHaveBeenCalledWith('mediaSeparateAudioAttempted',1);
      expect(operation).toHaveBeenCalledWith('mediaSeparateAudioProbed',1);
    } else {
      expect(f.deps.acquireAudio).not.toHaveBeenCalled();expect(result.coverage.audio.reason).toBe('no_audio_track');
      expect(operation.mock.calls.some(([name])=>name==='mediaSeparateAudioAttempted')).toBe(false);
    }
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|https:|SYNTHETIC|mp4a/);
    expect(JSON.stringify(result)).not.toContain('mediaSource');
  } finally {spy.mockRestore();}
});

test('ASR receives only captured public-post spelling context, never notes or baseline guesses',async()=>{
 const {buildTranscriptionContext}=require('../lib/media/transcriptionContext');
 const extracted={title:'Café São Bento',description:'Bánh mì Hồng, Lisboa'};
 const expected=buildTranscriptionContext(extracted);
 const readManifest=jest.fn(async()=>{extracted.description='MutatedLater';return null;});
 const f=fixture({readManifest});
 await jobContext.run(context(),()=>createVideoEvidence(f.deps)({
   url:'https://www.instagram.com/reel/CONTEXT/',extracted,
   ogData:{shareText:'PrivateDiary',description:'PrivateDiary',title:'GuessedVenue'},baselinePlaces:[{name:'GuessedVenue'}],
 }));
 const input=f.deps.transcribe.mock.calls[0][0];
 expect(input.context).toEqual(expected);
 expect(JSON.stringify(input.context)).not.toMatch(/PrivateDiary|GuessedVenue|MutatedLater/);
 expect(input.languageHint).toBeUndefined();
 const expectedKey=require('../lib/media/mediaEvidenceCache').manifestKey({
   url:'https://www.instagram.com/reel/CONTEXT/',extracted:{title:'Café São Bento',description:'Bánh mì Hồng, Lisboa'},
   ogData:{shareText:'PrivateDiary',description:'PrivateDiary',title:'GuessedVenue'},
   config:features.media.policy,userId:'u',baselinePlaces:[{name:'GuessedVenue'}],transcriptionContext:expected,
 });
 expect(readManifest).toHaveBeenCalledWith(expectedKey);
 // A spelling lexicon is never appended as independent spoken/visual evidence.
 expect(f.deps.fusion.mock.calls[0][0].textEvidence.some(e=>e.text.includes('Lexemes:'))).toBe(false);
});
test('private notes alone do not add an ASR context or alter the no-context request',async()=>{
 const f=fixture();
 await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',ogData:{shareText:'PrivateDiary',description:'PrivateDiary'}}));
 expect(f.deps.transcribe.mock.calls[0][0]).not.toHaveProperty('context');
});
