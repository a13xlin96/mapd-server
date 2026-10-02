jest.mock('../lib/cache',()=>({redis:null}));
jest.mock('../lib/firestore',()=>({firestore:null}));
const {createHash}=require('crypto');
const {prepareAudioChunks}=require('../lib/media/audioDecode');
const {createTranscriptionService,SERVER_PUBLIC_SCOPE}=require('../lib/media/transcriptionService');
const {EngineError}=require('../lib/engineError');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=hash('source');
const durationMs=32806.939,decodedEnd=32718.3125;
const policy={policyVersion:'media-v2',analysisMode:'audio-only'};
const info=()=>({hasAudio:true,durationMs,startMs:0,audioStartMs:0,audioStreamIndex:1,
  timing:{videoStartMs:0,videoDurationMs:32700}});
async function decode(processed=info(),end=decodedEnd,options={}) {
  const first=Math.ceil((processed.audioStartMs || 0)*16),samples=Math.floor(end*16)-first,stdout=Buffer.alloc(samples*2,1);
  const runFfmpeg=jest.fn(async()=>({stdout,
    stderr:`[Parsed_ashowinfo_3] n:0 pts:${first} pts_time:${first/16000} fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:${samples}`}));
  const chunks=await prepareAudioChunks({media:{contentDigest:digest},processed,...options},{runFfmpeg});
  return {chunks,runFfmpeg};
}
function service(failSecond=false) {
  const requests=[];
  const adapter={id:'openai',model:'gpt-4o-mini-transcribe-2025-12-15',version:'completion-test-v1',
    transcribeChunk:jest.fn(async chunk=>{
      if(failSecond && chunk.startMs>0)throw new EngineError('rate_limited');
      return {text:'Cafe'};
    })};
  const s=createTranscriptionService({providers:{openai:adapter},
    providerCall:async(_p,work)=>work(),sharedOperation:async(options,work)=>{requests.push(options);return work();}});
  return {adapter,requests,run:(chunks,extra={},opts={})=>s.transcribe({chunks,durationMs,mediaDigest:digest,...extra},
    {scope:SERVER_PUBLIC_SCOPE,policy,...opts})};
}
test('full clean audio reaching video end is complete without claiming an inflated AAC metadata tail',async()=>{
  const {chunks,runFfmpeg}=await decode(),s=service();
  const result=await s.run(chunks);
  expect(result.coverage).toEqual({status:'complete',reason:'available_audio_complete',intervals:[[0,chunks.at(-1).endMs]]});
  expect(result.segments.at(-1).endMs).toBe(chunks.at(-1).endMs);
  expect(result.segments.at(-1).endMs).toBeCloseTo(decodedEnd,6);
  expect(result.retryOperations).toEqual([]);
  expect(runFfmpeg).toHaveBeenCalledTimes(1);expect(s.adapter.transcribeChunk).toHaveBeenCalledTimes(2);
});
test('legacy mode and unproven arrays retain partial coverage; request identity is unchanged',async()=>{
  const {chunks}=await decode(),s=service();
  await s.run(chunks);const audioRequests=s.requests.splice(0);
  const legacy=await s.run(chunks,{}, {policy:{}});
  expect(legacy.coverage.status).toBe('partial');
  const {identity}=require('../lib/sharedAiIdentity');
  expect(s.requests.map(identity)).toEqual(audioRequests.map(identity));
  expect((await s.run([...chunks])).coverage.status).toBe('partial');
});
test.each([
  ['clipped input',p=>({...p,clipEndMs:32800})],
  ['offset audio',p=>({...p,audioStartMs:0.125})],
  ['unknown video end',p=>({...p,timing:{videoStartMs:0}})],
  ['video lasts beyond decoded sound',p=>({...p,timing:{videoStartMs:0,videoDurationMs:32800}})],
  ['different video origin',p=>({...p,timing:{videoStartMs:1,videoDurationMs:32700}})],
  ['separate audio',p=>({...p,separateAudio:{version:1,originMs:0,transform:'copyts-video-origin-pcm16k-mono-v1'}})],
])('%s cannot certify a metadata-only tail',async(_name,edit)=>{
  const {chunks}=await decode(edit(info()));
  expect((await service().run(chunks)).coverage.status).toBe('partial');
});
test.each(['drop-last','drop-first','changed-bytes','changed-window','wrong-source','wrong-duration'])('%s cannot reuse decode provenance',async kind=>{
  const {chunks}=await decode(),extra={};
  if(kind==='drop-last')chunks.pop();
  if(kind==='drop-first')chunks.shift();
  if(kind==='changed-bytes') {chunks[0].audioBytes[50]^=1;chunks[0].audioSha256=hash(chunks[0].audioBytes);}
  if(kind==='changed-window')chunks[0].startMs=0.125;
  if(kind==='wrong-source')extra.mediaDigest=hash('another source');
  if(kind==='wrong-duration')extra.durationMs=durationMs+10;
  expect((await service().run(chunks,extra)).coverage.status).toBe('partial');
});
test('failed transcription cannot certify complete available audio',async()=>{
  const {chunks}=await decode(),result=await service(true).run(chunks);
  expect(result.coverage).toMatchObject({status:'partial',reason:'audio_chunk_failed'});
});
test('decode failure and discontinuity cannot produce a completion proof',async()=>{
  const input={media:{contentDigest:digest},processed:info()};
  await expect(prepareAudioChunks(input,{runFfmpeg:async()=>{throw new EngineError('dependency_error');}}))
    .rejects.toMatchObject({code:'dependency_error'});
  await expect(prepareAudioChunks(input,{runFfmpeg:async()=>({stdout:Buffer.alloc(3200),stderr:
    '[Parsed_ashowinfo_3] n:0 pts:0 pts_time:0 fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:800\n'+
    '[Parsed_ashowinfo_3] n:1 pts:900 pts_time:0.05625 fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:800'})}))
    .rejects.toMatchObject({stage:'audio_timeline'});
});
test('cancellation after preparation remains a failure',async()=>{
  const {chunks}=await decode(),controller=new AbortController();controller.abort();
  await expect(service().run(chunks,{}, {signal:controller.signal})).rejects.toMatchObject({code:'attempt_stopped'});
});
