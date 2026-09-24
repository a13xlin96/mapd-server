'use strict';
const {createHash}=require('crypto');
const {EngineError}=require('../engineError');
const {validateMediaConfig}=require('./mediaConfig');
const {validateFrame}=require('./evidenceContract');
const {runFfmpeg}=require('./mediaProcess');
const {analyzeGrayFrame,hammingDistance}=require('./textRegions');
const fail=()=>{throw new EngineError('invalid_response',{stage:'frame_selection'});};
const clamp=value=>Math.max(0,Math.min(1,value));
function videoMap(processed) {
  if(!Number.isSafeInteger(processed.videoStreamIndex) || processed.videoStreamIndex<0 || processed.videoStreamIndex>1023)fail();
  return `0:${processed.videoStreamIndex}`;
}
// Eight frames fit the vision adapter's 12MiB request limit (and its 2MiB/frame limit).
const MAX_FRAME_BYTES=1536*1024;
const MAX_RGB_PIXELS=Math.floor((MAX_FRAME_BYTES-64*1024)/3);
/** Parse FFmpeg-produced PNG stream incrementally; bound each image before buffering payloads. */
function pngCollector(maxFrames) {
  let pending=Buffer.alloc(0),offset=8;
  const frames=[];
  return {frames,push(chunk) {
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=8) {
      if(pending.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail();
      if(pending.length<offset+8)break;
      const length=pending.readUInt32BE(offset),type=pending.toString('ascii',offset+4,offset+8),next=offset+12+length;
      if(next>MAX_FRAME_BYTES)throw new EngineError('input_too_large',{stage:'frame_selection'});
      if(pending.length<next)break;
      offset=next;
      if(type==='IEND') {
        if(length!==0 || frames.length>=maxFrames)fail();
        frames.push(Buffer.from(pending.subarray(0,offset)));pending=pending.subarray(offset);offset=8;
      }
    }
  },finish(){if(pending.length)fail();return frames;}};
}
function dimensions(width,height,longEdge) {
  const ratio=Math.min(1,longEdge/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*ratio)),height:Math.max(1,Math.round(height*ratio))};
}
/** Aspect-fit RGB24 geometry bounded before encoding, including incompressible noise.
 * Reserve 64KiB for row filters, DEFLATE expansion and PNG chunks. The collector independently
 * enforces the final byte cap. No encode retry/full second decode is needed on detailed video.
 */
function frameDimensions(width,height,longEdge) {
  if(![width,height,longEdge].every(n=>Number.isInteger(n) && n>0 && n<=3840))fail();
  const ratio=Math.min(1,longEdge/Math.max(width,height),Math.sqrt(MAX_RGB_PIXELS/(width*height)));
  return {width:Math.max(1,Math.floor(width*ratio)),height:Math.max(1,Math.floor(height*ratio))};
}
/** Decoder PTS, not frame-number/fps estimates. showinfo also establishes actual autorotated dimensions. */
function parseFramePts(stderr) {
  return [...stderr.matchAll(/\[Parsed_showinfo[^\]]*\][^\n]*\bn:\s*\d+[^\n]*\bpts_time:([\d.eE+-]+)[^\n]*\bs:(\d+)x(\d+)/g)]
    .map(match=>({timestampMs:Math.round(Number(match[1])*1000),width:Number(match[2]),height:Number(match[3])}));
}
function sceneScores(stderr) {
  const result=new Map();let timestamp;
  for(const line of stderr.split('\n')) {
    const t=line.match(/\[Parsed_metadata[^\]]*\].*pts_time:([\d.eE+-]+)/);
    if(t)timestamp=Math.round(Number(t[1])*1000);
    const s=line.match(/lavfi\.scd\.score=([\d.eE+-]+)/);
    if(s && Number.isFinite(timestamp))result.set(timestamp,clamp(Number(s[1])/100));
  }
  return result;
}
/** Scan local video at six samples/sec plus cut frames and final 200ms. Gray bytes are consumed
 * online: retain metrics only, not the whole raw video. +/-250ms cut neighborhoods are marked later.
 */
async function scanFrames({media,processed,signal,deadline,config={}},deps={}) {
  const policy=validateMediaConfig(config),size=dimensions(processed.width,processed.height,policy.scanLongEdge);
  if(size.width<9 || size.height<9)fail();
  const frameBytes=size.width*size.height,metrics=[];let pending=Buffer.alloc(0),previous;
  const start=processed.clipStartMs/1000,end=processed.clipEndMs/1000;
  const filter=`trim=start=${start}:end=${end},scale=${size.width}:${size.height},setsar=1,format=gray,scdet=threshold=10,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${1/policy.scanFps})+gt(scene,0.10)+gte(t,${Math.max(start,end-0.2)})',metadata=mode=print:key=lavfi.scd.score,showinfo`;
  const result=await (deps.runFfmpeg || runFfmpeg)({media,signal,deadline,config:policy,maxStdoutBytes:frameBytes*4096,
    args:['-map',videoMap(processed),'-an','-sn','-dn','-vf',filter,'-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1'],
    onStdout(chunk) {
      pending=Buffer.concat([pending,chunk]);
      while(pending.length>=frameBytes) {
        if(metrics.length>=4096)throw new EngineError('input_too_large',{stage:'frame_scan'});
        const metric=analyzeGrayFrame(pending.subarray(0,frameBytes),size.width,size.height,previous);
        metrics.push(metric);previous=metric;pending=pending.subarray(frameBytes);
      }
    }},deps);
  const timestamps=parseFramePts(result.stderr),scenes=sceneScores(result.stderr);
  if(pending.length || timestamps.length!==metrics.length || !metrics.length)fail();
  const candidates=metrics.map((metric,i)=>{
    const timestampMs=timestamps[i].timestampMs;
    if(!Number.isFinite(timestampMs) || timestampMs<processed.clipStartMs-1 || timestampMs>processed.clipEndMs
        || i>0 && timestampMs<timestamps[i-1].timestampMs)fail();
    const sceneScore=scenes.get(timestampMs) || 0;
    return {...metric,timestampMs,sceneScore,selectionReasons:[sceneScore>=0.1?'scene_change':'timeline_grid'],
      score:0.4*metric.clarity+0.4*metric.novelRegionScore+0.2*sceneScore};
  });
  candidates[0].selectionReasons.push('first_frame');candidates.at(-1).selectionReasons.push('last_frame');
  const cuts=candidates.filter(c=>c.sceneScore>=0.1);
  for(const cut of cuts)for(const direction of [-1,1]) {
    const target=cut.timestampMs+direction*250;
    const neighbor=candidates.reduce((best,c)=>Math.abs(c.timestampMs-target)<Math.abs(best.timestampMs-target)?c:best,candidates[0]);
    if(Math.abs(neighbor.timestampMs-target)<=175 && !neighbor.selectionReasons.includes('cut_neighborhood'))neighbor.selectionReasons.push('cut_neighborhood');
  }
  return {candidates,scannedFrames:candidates.length,policy:'scene-grid-v1'};
}
const rank=(a,b)=>b.score-a.score || a.timestampMs-b.timestampMs || a.digest.localeCompare(b.digest);
/** Deterministic eight-bin coverage + local novelty ranking. Near-duplicates within a bin retain
 * the sharper frame; separate bins retain temporal coverage, but exact hashes are never resent.
 */
function rankFrames(candidates,{startMs=0,endMs,limit=8,maxCandidates=240,excludeDigests=[]}={}) {
  if(!Number.isFinite(endMs) || endMs<=startMs || !Number.isInteger(limit) || limit<1 || limit>16)fail();
  const bins=Array.from({length:8},()=>[]),excluded=new Set(excludeDigests);
  for(const frame of candidates) {
    if(!Number.isFinite(frame.timestampMs) || !Number.isFinite(frame.score) || frame.timestampMs<startMs || frame.timestampMs>endMs)fail();
    if(excluded.has(frame.digest))continue;
    const bin=Math.min(7,Math.floor((frame.timestampMs-startMs)/(endMs-startMs)*8));
    const duplicate=bins[bin].findIndex(f=>hammingDistance(f.perceptualHash,frame.perceptualHash)<=6);
    if(duplicate>=0) {
      const other=bins[bin][duplicate];
      if(frame.clarity>other.clarity || frame.clarity===other.clarity && rank(frame,other)<0)bins[bin][duplicate]=frame;
    }else bins[bin].push(frame);
  }
  bins.forEach(bin=>bin.sort(rank));
  // Fair shortlist: capped globally while preserving each non-empty timeline bin.
  const short=Array.from({length:8},()=>[]);let kept=0;
  for(let round=0;kept<maxCandidates;round++) {
    let added=false;
    for(let bin=0;bin<8 && kept<maxCandidates;bin++)if(bins[bin][round]){short[bin].push(bins[bin][round]);kept++;added=true;}
    if(!added)break;
  }
  const selected=[],hashes=new Set(excludeDigests);
  while(selected.length<limit) {
    let added=false;
    for(const bin of short) {
      while(bin.length && hashes.has(bin[0].digest))bin.shift();
      if(bin.length && selected.length<limit) {
        const frame=bin.shift();selected.push(frame);hashes.add(frame.digest);added=true;
      }
    }
    if(!added)break;
  }
  return selected.sort((a,b)=>a.timestampMs-b.timestampMs);
}

/** Emit normalized local PNG bytes with ORIGINAL media-relative PTS and post-rotation geometry.
 * Every frame is RGB24 and <=1.5MiB; width/height describe the actual encoded, possibly downscaled
 * image. Outputs stream into bounded memory, never staging another video-sized set on disk.
 * Caller may request maxFrames once and split returned array into initial/expansion batches.
 * Incomplete/malformed/oversized encode rejects with EngineError: callers must record failed or
 * partial visual coverage, never translate that rejection into an empty complete result.
 * This is a one-shot selection API; exclusion/replacement passes are not supported. Calling it
 * once at maxFrames lets the coordinator split initial/expansion batches without redecoding.
 */
async function selectFrames({media,processed,signal,deadline,config={},limit,excludeDigests},deps={}) {
  if(excludeDigests!==undefined)fail();
  const policy=validateMediaConfig(config);
  const maximum=limit ?? policy.initialFrames;
  if(!Number.isInteger(maximum) || maximum<1 || maximum>policy.maxFrames)fail();
  const release=media.retain();
  try {
    const scan=await scanFrames({media,processed,signal,deadline,config:policy},deps);
    const chosen=rankFrames(scan.candidates,{startMs:processed.clipStartMs,endMs:processed.clipEndMs,
      limit:maximum,maxCandidates:policy.maxCandidates});
    if(!chosen.length)fail();
    const size=frameDimensions(processed.width,processed.height,policy.frameLongEdge);
    const expression=chosen.map(f=>`between(t,${(f.timestampMs-0.6)/1000},${(f.timestampMs+0.6)/1000})`).join('+');
    const images=pngCollector(chosen.length);
    const result=await (deps.runFfmpeg || runFfmpeg)({media,signal,deadline,config:policy,
      onStdout:chunk=>images.push(chunk),maxStdoutBytes:chosen.length*MAX_FRAME_BYTES,
      args:['-map',videoMap(processed),'-an','-sn','-dn','-vf',`select='${expression}',scale=${size.width}:${size.height},setsar=1,format=rgb24,showinfo`,
        '-fps_mode','passthrough','-frames:v',String(chosen.length),'-threads','1','-c:v','png','-compression_level','3',
        '-pix_fmt','rgb24','-f','image2pipe','pipe:1']},deps);
    const pts=parseFramePts(result.stderr);
    const encoded=images.finish();
    if(pts.length!==chosen.length || encoded.length!==chosen.length)fail();
    const frames=[],seen=new Set();
    for(let i=0;i<chosen.length;i++) {
      const bytes=encoded[i];
      if(bytes.length<24 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail();
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),digest=createHash('sha256').update(bytes).digest('hex');
      if(width!==size.width || height!==size.height || pts[i].width!==width || pts[i].height!==height
          || Math.abs(pts[i].timestampMs-chosen[i].timestampMs)>1)fail();
      const frame=validateFrame({digest,timestampMs:pts[i].timestampMs,width,height},processed.durationMs);
      if(!seen.has(digest))frames.push({...frame,bytes,mimeType:'image/png',selectionReasons:chosen[i].selectionReasons,
        sourceDigest:media.contentDigest,crop:[0,0,1,1]});
      seen.add(digest);
    }
    await media.assertQuota();
    return {frames,scannedFrames:scan.scannedFrames,policy:scan.policy,additionalFramesAvailable:frames.length>policy.initialFrames,
      coverage:{status:'complete',intervals:[[processed.clipStartMs,processed.clipEndMs]]}};
  } finally {
    await release();
  }
}
module.exports={scanFrames,selectFrames,rankFrames,parseFramePts,dimensions,frameDimensions,pngCollector,MAX_FRAME_BYTES};
