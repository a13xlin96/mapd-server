'use strict';
const fs=require('fs').promises;
const os=require('os');
const path=require('path');
const {EventEmitter}=require('events');
const {processMedia,parseProbe,runLocalProcess,runFfmpeg,withDecodeSlot}=require('../lib/media/mediaProcess');
jest.mock('../lib/providerRuntime',()=>({withProvider:(_p,work)=>work(),withLease:(_key,work)=>work()}));
const {createWorkspace}=require('../lib/media/publicMediaDownload');
const {prepareAudioChunks}=require('../lib/media/audioDecode');
let root,media;
const probe={format:{duration:'30',start_time:'0',format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[{index:0,codec_type:'video',width:1280,height:720},{index:1,codec_type:'audio'}]};
function audioInfo(n,pts,samples) {return `[Parsed_ashowinfo_2 @ 0x0] n:${n} pts:${pts} pts_time:${pts/16000} fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:${samples}\n`;}
function fakeProcess() {const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=jest.fn(()=>setImmediate(()=>p.emit('close',null)));return p;}
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'media-process-'));media={...await createWorkspace({root}),container:'mp4'};media.path=path.join(media.directory,'source.media');await fs.writeFile(media.path,'synthetic input');});
afterEach(async()=>{await media.dispose();await fs.rm(root,{recursive:true,force:true});});
test('probe returns autorotated geometry and validates bounded clip offsets',async()=>{
  const spawn=jest.fn(()=>{const p=fakeProcess();setImmediate(()=>{p.stdout.emit('data',Buffer.from(JSON.stringify({...probe,streams:[{...probe.streams[0],side_data_list:[{rotation:-90}]},probe.streams[1]]})));p.emit('close',0);});return p;});
  const result=await processMedia({media,clip:{startMs:1000,endMs:9000}},{spawn});
  expect(result).toMatchObject({width:720,height:1280,rotation:270,durationMs:30000,clipStartMs:1000,clipEndMs:9000,hasAudio:true,videoStreamIndex:0,audioStreamIndex:1});
  const args=spawn.mock.calls[0][1];expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist','file','-enable_drefs','0','-use_absolute_path']));
});
test.each([{format:{...probe.format,duration:'NaN'}},{format:{...probe.format,duration:'181'}},{streams:[{codec_type:'video',width:5000,height:3000}]},{format:{...probe.format,format_name:'hls'}}])('rejects unsupported/hostile probe data %p',override=>{
  expect(()=>parseProbe({...probe,...override})).toThrow();
});
test('no-audio probe is valid; symlink source is rejected before spawning',async()=>{
  expect(parseProbe({...probe,streams:[probe.streams[0]]}).hasAudio).toBe(false);
  await fs.unlink(media.path);await fs.symlink('/etc/hosts',media.path);
  const spawn=jest.fn();await expect(processMedia({media},{spawn})).rejects.toMatchObject({code:'access_blocked'});expect(spawn).not.toHaveBeenCalled();
});
test('deadline kills child and settles only on close',async()=>{
  const p=fakeProcess();p.kill.mockImplementation(()=>{});let finished=false;
  const work=runLocalProcess('ffmpeg',[],{deadline:Date.now()+20},{spawn:()=>p}).catch(e=>{finished=true;return e;});
  await new Promise(resolve=>setTimeout(resolve,40));expect(p.kill).toHaveBeenCalledWith('SIGKILL');expect(finished).toBe(false);
  p.emit('close',null);expect((await work).code).toBe('dependency_timeout');
});
test('cancellation preserves operation input until child closes',async()=>{
  const p=fakeProcess();p.kill.mockImplementation(()=>{});const controller=new AbortController();
  const work=runFfmpeg({media,args:['-f','null','-'],signal:controller.signal},{spawn:()=>p}).catch(e=>e);
  await new Promise(setImmediate);await media.dispose();controller.abort();
  expect(await fs.readFile(media.path,'utf8')).toBe('synthetic input');
  p.emit('close',null);expect((await work).code).toBe('attempt_stopped');await expect(fs.stat(media.directory)).rejects.toMatchObject({code:'ENOENT'});
});
test('bounded stdout cannot allocate unlimited decoder output',async()=>{
  const p=fakeProcess();const work=runLocalProcess('ffmpeg',[],{maxStdoutBytes:16},{spawn:()=>p});
  p.stdout.emit('data',Buffer.alloc(17));await expect(work).rejects.toMatchObject({code:'input_too_large'});
});
test('cancelled decoder waiter never starts and does not deadlock the queue',async()=>{
  let finish;const first=withDecodeSlot(()=>new Promise(resolve=>{finish=resolve;}));
  const controller=new AbortController(),next=jest.fn();
  const second=withDecodeSlot(next,{signal:controller.signal}).catch(e=>e);controller.abort();
  expect((await second).code).toBe('attempt_stopped');finish();await first;await withDecodeSlot(next);expect(next).toHaveBeenCalledTimes(1);
});
test('missing binary fails explicitly rather than silently using an unbounded decoder',async()=>{
  const p=fakeProcess();const work=runLocalProcess('absent',[],{}, {spawn:()=>p});p.emit('error',new Error('ENOENT'));
  await expect(work).rejects.toMatchObject({code:'dependency_error'});
});
test('post-spawn error kills child but retains workspace and decoder slot until close',async()=>{
  const p=fakeProcess();p.kill.mockImplementation(()=>{});let finished=false;
  let ready;const spawned=new Promise(resolve=>{ready=resolve;});
  const spawn=jest.fn(()=>{setImmediate(()=>{p.emit('spawn');ready();});return p;});
  const work=runFfmpeg({media,args:['-f','null','-']},{spawn}).catch(e=>{finished=true;return e;});
  await spawned;await media.dispose();
  p.emit('error',new Error('post-spawn I/O error'));await new Promise(setImmediate);
  expect(p.kill).toHaveBeenCalledWith('SIGKILL');expect(finished).toBe(false);
  expect(await fs.readFile(media.path,'utf8')).toBe('synthetic input');
  const next=jest.fn();const queued=withDecodeSlot(next);await new Promise(setImmediate);expect(next).not.toHaveBeenCalled();
  p.emit('close',null);expect((await work).code).toBe('dependency_error');await queued;
  await expect(fs.stat(media.directory)).rejects.toMatchObject({code:'ENOENT'});
  expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-xerror','-err_detect','explode']));
});
test('probe binds the first validated video/audio by absolute stream index, not automatic preference',()=>{
  const result=parseProbe({...probe,streams:[{...probe.streams[0],index:3},
    {index:4,codec_type:'video',width:5000,height:1000},{index:7,codec_type:'audio'}]});
  expect(result).toMatchObject({videoStreamIndex:3,audioStreamIndex:7,width:1280,height:720});
  expect(()=>parseProbe({...probe,streams:[{...probe.streams[0],index:undefined}]})).toThrow();
});
test('audio decoder executes once, cuts valid bounded WAV, overlap and source times retained',async()=>{
  const run=jest.fn().mockResolvedValue({stdout:Buffer.alloc(30*16000*2),stderr:audioInfo(0,0,30*16000)});
  const chunks=await prepareAudioChunks({media,processed:{...parseProbe(probe),clipStartMs:0,clipEndMs:30000}},{runFfmpeg:run});
  expect(run).toHaveBeenCalledTimes(1);expect(chunks.map(c=>[c.startMs,c.endMs])).toEqual([[0,20000],[19000,30000]]);
  expect(chunks[0].audioBytes.toString('ascii',0,4)).toBe('RIFF');expect(chunks[0].audioBytes.readUInt32LE(40)).toBe(20*16000*2);
  expect(chunks[0].audioSha256).toMatch(/^[a-f0-9]{64}$/);expect(chunks[0].audioBytes.length).toBeLessThan(2*1024*1024);
  expect(run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['-map','0:1']));
  expect(run.mock.calls[0][0].args.join(' ')).toContain('ashowinfo');
});
test('no audio and fully covered subtitle timeline incur no decode',async()=>{
  const run=jest.fn();
  expect(await prepareAudioChunks({media,processed:{...parseProbe(probe),hasAudio:false}},{runFfmpeg:run})).toEqual([]);
  expect(await prepareAudioChunks({media,processed:parseProbe(probe),subtitles:{segments:[],coverage:{status:'complete',intervals:[[0,30000]]}}},{runFfmpeg:run})).toEqual([]);
  expect(run).not.toHaveBeenCalled();
});
test('short decode leaves tail uncovered; explicit clip preserves original offsets',async()=>{
  const run=jest.fn().mockResolvedValue({stdout:Buffer.alloc(3*16000*2),stderr:audioInfo(0,10*16000,3*16000)});
  const chunks=await prepareAudioChunks({media,processed:{...parseProbe(probe),clipStartMs:10000,clipEndMs:20000}},{runFfmpeg:run});
  expect(chunks.map(c=>[c.startMs,c.endMs])).toEqual([[10000,13000]]);
});
test('delayed audio stream retains its real original offset',async()=>{
  const processed=parseProbe({...probe,streams:[probe.streams[0],{index:1,codec_type:'audio',start_time:'2'}]});
  const chunks=await prepareAudioChunks({media,processed},{runFfmpeg:async()=>({stdout:Buffer.alloc(5*16000*2),stderr:audioInfo(0,2*16000,5*16000)})});
  expect(chunks[0]).toMatchObject({startMs:2000,endMs:7000});
});
test.each(['gap','overlap','no_pts','byte_mismatch'])('audio %s rejects instead of relabeling later speech into earlier subtitles',async kind=>{
  const stderr=kind==='no_pts'?'':audioInfo(0,0,5*16000)+audioInfo(1,(kind==='gap'?10:kind==='overlap'?4:5)*16000,5*16000);
  const run=jest.fn().mockResolvedValue({stdout:Buffer.alloc((kind==='byte_mismatch'?9:10)*16000*2),stderr});
  await expect(prepareAudioChunks({media,processed:parseProbe(probe),subtitles:{segments:[{text:'covered only beginning',startMs:0,endMs:5000}],
    coverage:{status:'partial',intervals:[[0,5000]]}}},{runFfmpeg:run})).rejects.toMatchObject({code:'invalid_response',stage:'audio_timeline'});
  expect(run).toHaveBeenCalledTimes(1);
});
function fragmentedSubtitles() {
  const segments=Array.from({length:100},(_,i)=>({text:`caption ${i}`,startMs:45000+i*1000,endMs:45500+i*1000}));
  return {segments,coverage:{status:'partial',intervals:[[0,40000],...segments.map(s=>[s.startMs,s.endMs])]}};
}
test('100 subtitle gaps use bounded grid chunks, skip fully covered windows, and cover every actual gap',async()=>{
  const processed={...parseProbe({...probe,format:{...probe.format,duration:'180'}}),clipStartMs:0,clipEndMs:180000};
  const subtitles=fragmentedSubtitles(),pcm=Buffer.alloc(180*16000*2);
  for(let sample=0;sample<pcm.length/2;sample++)pcm.writeInt16LE(sample%30000,sample*2);
  const run=jest.fn().mockResolvedValue({stdout:pcm,stderr:audioInfo(0,0,180*16000)});
  const chunks=await prepareAudioChunks({media,processed,subtitles},{runFfmpeg:run});
  expect(run).toHaveBeenCalledTimes(1);expect(chunks).toHaveLength(8);
  expect(chunks[0].startMs).toBe(38000); // Fully subtitle-covered 0–20 and 19–39s skipped.
  expect(chunks.at(-1).endMs).toBe(180000);
  for(const chunk of chunks) {
    expect(chunk.endMs-chunk.startMs).toBeLessThanOrEqual(20000);
    expect(chunk.audioBytes.subarray(44).equals(pcm.subarray(chunk.startMs*32,chunk.endMs*32))).toBe(true);
    expect(chunk.audioBytes.readUInt32LE(40)).toBe((chunk.endMs-chunk.startMs)*32);
    expect(chunk.audioSha256).toBe(require('crypto').createHash('sha256').update(chunk.audioBytes).digest('hex'));
  }
  expect(require('../lib/media/audioSegments').missingIntervals([
    ...subtitles.coverage.intervals,...chunks.map(c=>[c.startMs,c.endMs])],180000)).toEqual([]);
  // Exercise the real facade's count/WAV validation with a local fake provider, never an API.
  const provider={id:'openai',model:require('../lib/media/mediaConfig').DEFAULT_MEDIA_CONFIG.model,version:'fixture-v1',
    transcribeChunk:jest.fn(async()=>({text:'',segments:[]}))};
  const service=require('../lib/media/transcriptionService').createTranscriptionService({providers:{openai:provider},
    sharedOperation:async(_options,work)=>work(),providerCall:async(_id,work)=>work()});
  const transcript=await service.transcribe({mediaDigest:'a'.repeat(64),durationMs:180000,chunks,subtitles});
  expect(provider.transcribeChunk).toHaveBeenCalledTimes(8);
  expect(transcript.coverage).toEqual({status:'complete',intervals:[[0,180000]]});
});
test('fragmented-plan fallback preserves a clipped/truncated decode without padding the uncovered tail',async()=>{
  const processed={...parseProbe({...probe,format:{...probe.format,duration:'180'}}),clipStartMs:20000,clipEndMs:180000};
  const subtitles=fragmentedSubtitles(),pcm=Buffer.alloc(83*16000*2,0x7a);
  const run=jest.fn().mockResolvedValue({stdout:pcm,stderr:audioInfo(0,20*16000,83*16000)});
  const chunks=await prepareAudioChunks({media,processed,subtitles},{runFfmpeg:run});
  expect(run).toHaveBeenCalledTimes(1);expect(chunks.length).toBeLessThanOrEqual(32);
  expect(chunks[0].startMs).toBe(38000);expect(chunks.at(-1).endMs).toBe(103000);
  for(const chunk of chunks)expect(chunk.audioBytes.subarray(44).equals(pcm.subarray((chunk.startMs-20000)*32,(chunk.endMs-20000)*32))).toBe(true);
  const missing=require('../lib/media/audioSegments').missingIntervals([
    ...subtitles.coverage.intervals,...chunks.map(c=>[c.startMs,c.endMs])],180000);
  expect(missing).toContainEqual([144500,180000]);expect(missing.every(([lo])=>lo>=103000)).toBe(true);
});
test('tighter chunk duration still respects the 32-request cap and leaves excess audio honestly uncovered',async()=>{
  const processed=parseProbe({...probe,format:{...probe.format,duration:'180'}});
  const run=jest.fn().mockResolvedValue({stdout:Buffer.alloc(180*16000*2),stderr:audioInfo(0,0,180*16000)});
  const chunks=await prepareAudioChunks({media,processed,config:{audioChunkMs:2000}},{runFfmpeg:run});
  expect(run).toHaveBeenCalledTimes(1);expect(chunks).toHaveLength(32);
  expect(chunks.every(c=>c.endMs-c.startMs<=2000)).toBe(true);
  expect(require('../lib/media/audioSegments').missingIntervals(chunks.map(c=>[c.startMs,c.endMs]),180000)).toEqual([[33000,180000]]);
});
