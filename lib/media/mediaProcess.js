'use strict';
const {spawn} = require('child_process');
const {performance}=require('perf_hooks');
const metrics=require('../engineMetrics');
const measure=(stage,work)=>metrics.current()?.stage(stage,work) ?? work();
const fs = require('fs').promises;
const path = require('path');
const {EngineError} = require('../engineError');
const {validateMediaConfig} = require('./mediaConfig');
let decoding=false;
const waiters=[];
const failure=code=>new EngineError(code,{stage:'media_decode'});
function check(signal,deadline) {
  if (signal?.aborted) throw failure('attempt_stopped');
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw failure('dependency_timeout');
}
/** One local CPU decoder; waiting honors caller cancellation/deadline. Never a paid-call gate. */
async function withDecodeSlot(work,{signal,deadline=Date.now()+60000}={}) {
  check(signal,deadline);
  const queued=performance.now();
  try {
    if (decoding) await new Promise((resolve,reject)=>{
      let timer;
      const item={take(){clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{const at=waiters.indexOf(item);if(at>=0)waiters.splice(at,1);clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(failure(signal?.aborted?'attempt_stopped':'dependency_timeout'));};
      timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
      signal?.addEventListener('abort',abort,{once:true});waiters.push(item);
    });
    else decoding=true;
  } catch(error) {
    metrics.current()?.recordStage('media_decode_queue',performance.now()-queued,error.code==='dependency_timeout'?'timeout':'cancelled');
    throw error;
  }
  metrics.current()?.recordStage('media_decode_queue',performance.now()-queued,'success');
  try {check(signal,deadline);return await work();}
  finally {const next=waiters.shift();if(next)next.take();else decoding=false;}
}

/** Bounded local process. Resolves only after close: retain() resources stay alive through kill.
 * deps.spawn is injectable for process tests; production uses no shell and a private process group.
 * onStdout consumes chunks without buffering; all output still counts against maxStdoutBytes.
 */
function runLocalProcess(binary,args,{signal,deadline=Date.now()+20000,maxStdoutBytes=4*1024*1024,
  maxStderrBytes=4*1024*1024,onStdout,cwd,workspace}={},deps={}) {
  check(signal,deadline);
  return new Promise((resolve,reject)=>{
    let proc,settled=false,terminalError=null,stdoutBytes=0,stderrBytes=0,spawned=false;
    const stdout=[],stderr=[];
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(quotaTimer);signal?.removeEventListener('abort',onAbort);err?reject(err):resolve(result);};
    const kill=err=>{
      if(terminalError)return;terminalError=err;
      try {if(proc.pid && process.platform !== 'win32' && !deps.spawn)process.kill(-proc.pid,'SIGKILL');else proc.kill('SIGKILL');}
      catch {try{proc.kill('SIGKILL');}catch{}}
    };
    const onAbort=()=>kill(failure('attempt_stopped'));
    let timer,quotaTimer;
    try {proc=(deps.spawn || spawn)(binary,args,{cwd,shell:false,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',TMPDIR:cwd || process.env.TMPDIR || '/tmp',AV_LOG_FORCE_NOCOLOR:'1'}});}catch{return finish(failure('dependency_error'));}
    timer=setTimeout(()=>kill(failure('dependency_timeout')),Math.max(1,deadline-Date.now()));
    if(workspace)quotaTimer=setInterval(()=>workspace.assertQuota().catch(e=>kill(e)),100);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    proc.once('spawn',()=>{spawned=true;});
    proc.stdout.on('data',chunk=>{
      if(terminalError)return;
      const bytes=Buffer.from(chunk);stdoutBytes+=bytes.length;
      if(stdoutBytes>maxStdoutBytes)return kill(failure('input_too_large'));
      try {if(onStdout)onStdout(bytes);else stdout.push(bytes);}catch(e){kill(e instanceof EngineError?e:failure('invalid_response'));}
    });
    proc.stderr.on('data',chunk=>{
      if(terminalError)return;
      stderrBytes+=chunk.length;if(stderrBytes>maxStderrBytes)return kill(failure('input_too_large'));stderr.push(Buffer.from(chunk));
    });
    // A post-spawn error (including failed kill) does not mean the process has exited.
    // Keep its operation-owned workspace/CPU slot until close. ENOENT has no child to retain.
    proc.on('error',()=>{
      if(!spawned && !proc.pid)return finish(failure('dependency_error'));
      kill(failure('dependency_error'));
    });
    proc.on('close',code=>finish(terminalError || (code===0?null:failure('invalid_response')),
      {stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr).toString('utf8')}));
  });
}

/** Input files must remain inside the operation-owned workspace and be regular, not symlinks. */
async function assertLocalInput(media) {
  if (!media || typeof media.retain !== 'function' || !['mp4','webm'].includes(media.container)
      || path.dirname(path.resolve(media.path)) !== path.resolve(media.directory)) throw failure('access_blocked');
  const stat=await fs.lstat(media.path);
  if(!stat.isFile() || stat.isSymbolicLink())throw failure('access_blocked');
}
function localInputArgs(media) {
  // Restrict container probing and all nested protocol reads. MOV external data references
  // are explicitly disabled; HLS/DASH/concat cannot be auto-detected or opened.
  return ['-max_alloc','67108864','-max_pixels','8294400','-protocol_whitelist','file','-format_whitelist',media.container==='mp4'?'mov':'matroska,webm',
    ...(media.container==='mp4'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-i',media.path];
}
/** Shared decoder for audioSegments/frameSelector. args contain trusted output filters only.
 * Caller owns workspace paths; the operation reference survives initiating-caller disposal.
 */
async function runFfmpeg({media,args,signal,deadline,config={},onStdout,maxStdoutBytes,stage='media_decode',preserveTimestamps=false},deps={}) {
  const policy=validateMediaConfig(config),release=media.retain();
  try {
    await assertLocalInput(media);
    return await withDecodeSlot(()=>measure(stage,()=>runLocalProcess(deps.ffmpegPath || 'ffmpeg',
      ['-nostdin','-hide_banner','-xerror','-err_detect','explode','-threads','1','-filter_threads','1','-copyts',
        ...(preserveTimestamps?[]:['-start_at_zero']),...localInputArgs(media),...args],
      {signal,deadline:Math.min(deadline || Infinity,Date.now()+policy.mediaTimeoutMs),cwd:media.directory,
        workspace:media,onStdout,maxStdoutBytes},deps)),{signal,deadline:deadline || Date.now()+policy.mediaTimeoutMs});
  } finally {await release();}
}
function parseProbe(value,config={}) {
  const policy=validateMediaConfig(config);
  const video=value?.streams?.find(s=>s.codec_type==='video' && !s.disposition?.attached_pic);
  if(!video)throw failure('invalid_response');
  const durationMs=Number(value?.format?.duration || video.duration)*1000;
  const startMs=Number(value?.format?.start_time || 0)*1000;
  const width=Number(video.width),height=Number(video.height);
  if(!Number.isFinite(durationMs) || durationMs<=0 || durationMs>policy.maxDurationMs)throw failure('input_too_large');
  if(!Number.isFinite(startMs) || !Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1
      || Math.max(width,height)>3840 || Math.min(width,height)>2160)throw failure('input_too_large');
  const rawRotation=Number(video.side_data_list?.find(v=>v.rotation!=null)?.rotation || video.tags?.rotate || 0);
  if(!Number.isFinite(rawRotation) || rawRotation%90!==0)throw failure('invalid_response');
  const rotation=((rawRotation%360)+360)%360;
  const formatName=String(value.format?.format_name || '');
  if(!/^(?:mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|matroska|webm)$/.test(formatName))throw failure('invalid_response');
  const audio=value.streams.find(s=>s.codec_type==='audio');
  const validIndex=stream=>Number.isSafeInteger(stream?.index) && stream.index>=0 && stream.index<=1023;
  if(!validIndex(video) || audio && (!validIndex(audio) || audio.index===video.index))throw failure('invalid_response');
  const audioStartMs=audio ? Math.max(0,Number(audio.start_time ?? value.format?.start_time ?? 0)*1000-startMs) : null;
  if(audio && (!Number.isFinite(audioStartMs) || audioStartMs>durationMs))throw failure('invalid_response');
  return {durationMs,startMs,rotation,encodedWidth:width,encodedHeight:height,
    width:rotation%180?height:width,height:rotation%180?width:height,hasAudio:!!audio,audioStartMs,
    videoStreamIndex:video.index,audioStreamIndex:audio?.index ?? null,
    // Separate containers require explicit origins; the legacy default zero
    // is not sufficient authority to align independently timestamped streams.
    timelineOriginKnown:Number.isFinite(explicitNumber(value.format?.start_time)) && Number.isFinite(explicitNumber(video.start_time))
      && Number(video.start_time)*1000 === startMs};
}
const audioTimelineFailure=()=>{throw new EngineError('invalid_response',{stage:'audio_timeline'});};
const explicitNumber=value=>value !== null && value !== undefined && value !== ''
  && !(typeof value === 'string' && !value.trim())
  && ['string','number'].includes(typeof value) && Number.isFinite(Number(value)) ? Number(value) : NaN;
/** Narrow same-origin full-track contract. Both assets start on the exact
 * same clock origin; the standalone audio's container/stream durations agree.
 * Different end times are clipped to the video interval, never padded or
 * shifted by a guessed tolerance. Missing/shifted origins fail closed. */
function parseSeparateAudioProbe(value,video,config={}) {
  const policy=validateMediaConfig(config),audio=value?.streams?.[0];
  if (video?.hasAudio !== false || video.timelineOriginKnown !== true || !Number.isFinite(video.startMs)
      || !Number.isFinite(video.durationMs) || video.durationMs <= 0 || video.durationMs > policy.maxDurationMs
      || value?.streams?.length !== 1 || audio?.codec_type !== 'audio' || audio.codec_name !== 'aac'
      || !Number.isSafeInteger(audio.index) || audio.index < 0 || audio.index > 1023
      || audio.disposition?.attached_pic || !/^mov,mp4,m4a,3gp,3g2,mj2$/.test(value.format?.format_name || '')) audioTimelineFailure();
  const origin=explicitNumber(value.format.start_time)*1000,start=explicitNumber(audio.start_time)*1000;
  const duration=explicitNumber(audio.duration)*1000,formatDuration=explicitNumber(value.format.duration)*1000;
  const rate=explicitNumber(audio.sample_rate),channels=explicitNumber(audio.channels);
  const end=start+duration,videoEnd=video.startMs+video.durationMs;
  if (![origin,start,duration,formatDuration].every(Number.isFinite) || origin !== video.startMs
      || start !== origin || start >= videoEnd || duration <= 0 || duration > policy.maxDurationMs
      || formatDuration <= 0 || formatDuration > policy.maxDurationMs
      || formatDuration !== duration
      || !Number.isInteger(rate) || rate < 8000 || rate > 192000
      || !Number.isInteger(channels) || channels < 1 || channels > 8) audioTimelineFailure();
  return {...video,hasAudio:true,audioStreamIndex:audio.index,audioStartMs:start-video.startMs,
    separateAudio:{version:1,originMs:video.startMs,startMs:start,endMs:end,sampleRate:rate,channels,
      transform:'copyts-video-origin-pcm16k-mono-v1'}};
}
/** Probe without network access. clip offsets use media-relative milliseconds, never frame indexes.
 * Returns dimensions AFTER FFmpeg autorotation, explicit clip bounds, videoStreamIndex and
 * audioStreamIndex (null without audio). Every decode must map these absolute validated indexes,
 * not allow FFmpeg to automatically pick an unvalidated higher-resolution stream.
 * No audio file is created.
 */
async function processMedia({media,signal,deadline,config={},clip,audioForVideo},deps={}) {
  const policy=validateMediaConfig(config),release=media.retain();
  try {
    await assertLocalInput(media);
    check(signal,deadline);
    const result=await withDecodeSlot(()=>measure('media_probe',()=>runLocalProcess(deps.ffprobePath || 'ffprobe',
      ['-v','error',...localInputArgs(media),'-show_format','-show_streams','-of','json'],
      {signal,deadline:Math.min(deadline || Infinity,Date.now()+policy.requestTimeoutMs),maxStdoutBytes:1024*1024,cwd:media.directory,workspace:media},deps)),
    {signal,deadline:deadline || Date.now()+policy.requestTimeoutMs});
    let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw failure('invalid_response');}
    if (audioForVideo) return parseSeparateAudioProbe(parsed,audioForVideo,policy);
    const info=parseProbe(parsed,policy);
    const clipStartMs=clip?.startMs ?? 0,clipEndMs=clip?.endMs ?? info.durationMs;
    if(!Number.isFinite(clipStartMs) || !Number.isFinite(clipEndMs) || clipStartMs<0 || clipEndMs<=clipStartMs || clipEndMs>info.durationMs)throw failure('invalid_response');
    return {...info,clipStartMs,clipEndMs};
  } finally {await release();}
}
module.exports={processMedia,runFfmpeg,runLocalProcess,withDecodeSlot,assertLocalInput,localInputArgs,parseProbe,parseSeparateAudioProbe};
