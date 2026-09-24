'use strict';
const {createHash}=require('crypto');
const {EngineError}=require('../engineError');
const {validateMediaConfig}=require('./mediaConfig');
const {planAudioSegments,reusableSubtitles}=require('./audioSegments');
const {runFfmpeg}=require('./mediaProcess');
const RATE=16000,BYTES_PER_SAMPLE=2;
const MAX_AUDIO_CHUNKS=32; // Provider-independent facade's per-invocation bound.
const invalidTimeline=()=>{throw new EngineError('invalid_response',{stage:'audio_timeline'});};
/** Match output PCM samples to actual post-resample PTS, never byte-count guesses across gaps.
 * A discontinuity/overlap or unaccounted byte rejects this modality as incomplete. No padding.
 */
function decodedAudioTimeline(stderr,pcm,start,end) {
  const frames=[...String(stderr || '').matchAll(/\[Parsed_ashowinfo[^\]]*\][^\n]*\bn:(\d+)\s+pts:(-?\d+)\s+pts_time:[^\s]+[^\n]*\bfmt:s16\s+channels:1\s+[^\n]*\brate:16000\s+nb_samples:(\d+)/g)];
  if(!Buffer.isBuffer(pcm) || pcm.length%BYTES_PER_SAMPLE || !frames.length)invalidTimeline();
  let samples=0;const first=Number(frames[0][2]);
  for(let i=0;i<frames.length;i++) {
    const n=Number(frames[i][1]),pts=Number(frames[i][2]),count=Number(frames[i][3]);
    if(n!==i || !Number.isSafeInteger(pts) || !Number.isSafeInteger(count) || count<1
        || Math.abs(pts-(first+samples))>1)invalidTimeline();
    samples+=count;
  }
  if(samples*BYTES_PER_SAMPLE!==pcm.length || first<Math.floor(start*RATE/1000)-1
      || first+samples>Math.ceil(end*RATE/1000)+1)invalidTimeline();
  return {startMs:first/RATE*1000,endMs:(first+samples)/RATE*1000};
}
function wav(pcm) {
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(RATE,24);header.writeUInt32LE(RATE*BYTES_PER_SAMPLE,28);
  header.writeUInt16LE(BYTES_PER_SAMPLE,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
/** Decode one bounded PCM stream, then slice WAV buffers in memory (no repeated video decode).
 * @returns {Promise<Array<{audioBytes:Buffer,audioSha256:string,startMs:number,endMs:number}>>}
 * Buffers are independently owned; physical ASR producers copy them before sharing.
 * Missing/truncated tail is never padded into invented complete speech coverage; decoded PTS
 * must be continuous. Discontinuities reject with stage audio_timeline (no invented coverage).
 * clip offsets are media-relative; no-audio returns []; subtitles must have explicit coverage.
 * Fragmented subtitle gaps fall back to contiguous grid windows (normally 20s with 1s overlap),
 * skipping fully covered windows. At most 32 chunks are returned, including under a tighter
 * audioChunkMs policy; any remaining timeline stays uncovered for the facade to report partial.
 */
async function prepareAudioChunks({media,processed,subtitles=null,signal,deadline,config={}},deps={}) {
  const policy=validateMediaConfig(config);
  if(!processed.hasAudio)return [];
  const reused=reusableSubtitles(subtitles,processed.durationMs);
  let planned=planAudioSegments(processed.durationMs,{chunkMs:policy.audioChunkMs,overlapMs:policy.audioOverlapMs,
    coveredIntervals:reused.coveredIntervals});
  if(!planned.length)return [];
  const start=Math.max(processed.clipStartMs ?? 0,processed.audioStartMs ?? 0),end=processed.clipEndMs ?? processed.durationMs;
  if(start===end)return [];
  if(!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>policy.maxDurationMs)throw new EngineError('invalid_response',{stage:'audio_decode'});
  const maxBytes=Math.ceil((end-start)/1000*RATE)*BYTES_PER_SAMPLE;
  if(!Number.isSafeInteger(processed.audioStreamIndex) || processed.audioStreamIndex<0 || processed.audioStreamIndex>1023)invalidTimeline();
  const result=await (deps.runFfmpeg || runFfmpeg)({media,signal,deadline,config:policy,maxStdoutBytes:maxBytes+4096,
    args:['-vn','-sn','-dn','-map',`0:${processed.audioStreamIndex}`,'-af',
      `atrim=start=${start/1000}:end=${end/1000},aresample=16000:async=0,aformat=sample_fmts=s16:channel_layouts=mono,ashowinfo`,
      '-ac','1','-ar',String(RATE),'-c:a','pcm_s16le','-f','s16le','pipe:1']},deps);
  const pcm=result.stdout;
  if(!Buffer.isBuffer(pcm) || pcm.length%BYTES_PER_SAMPLE || pcm.length>maxBytes+4096)throw new EngineError('invalid_response',{stage:'audio_decode'});
  const timeline=decodedAudioTimeline(result.stderr,pcm,start,end);
  const decodedStart=timeline.startMs,decodedEnd=Math.min(end,timeline.endMs);
  const withinDecoded=interval=>({startMs:Math.max(interval.startMs,start,decodedStart),endMs:Math.min(interval.endMs,decodedEnd)});
  const needsAudio=interval=>interval.startMs<interval.endMs &&
    !reused.coveredIntervals.some(([lo,hi])=>lo<=interval.startMs && hi>=interval.endMs);
  planned=planned.map(withinDecoded).filter(needsAudio);
  if(planned.length>MAX_AUDIO_CHUNKS) {
    // Reuse this single decode; never concatenate separated gaps or pad their missing samples.
    // A little repeated subtitle-covered audio is preferable to an unbounded number of calls.
    planned=planAudioSegments(processed.durationMs,{chunkMs:policy.audioChunkMs,overlapMs:policy.audioOverlapMs})
      .map(withinDecoded).filter(needsAudio);
  }
  return planned.slice(0,MAX_AUDIO_CHUNKS).flatMap(interval=>{
    const startMs=Math.max(interval.startMs,start,decodedStart),endMs=Math.min(interval.endMs,decodedEnd);
    if(startMs>=endMs)return [];
    const lo=Math.ceil((startMs-decodedStart)*RATE/1000)*BYTES_PER_SAMPLE,hi=Math.floor((endMs-decodedStart)*RATE/1000)*BYTES_PER_SAMPLE;
    if(hi<=lo)return [];
    const audioBytes=wav(pcm.subarray(lo,hi));
    return [{audioBytes,audioSha256:createHash('sha256').update(audioBytes).digest('hex'),
      startMs:decodedStart+lo/BYTES_PER_SAMPLE/RATE*1000,endMs:decodedStart+hi/BYTES_PER_SAMPLE/RATE*1000}];
  });
}
module.exports={prepareAudioChunks,decodedAudioTimeline};
