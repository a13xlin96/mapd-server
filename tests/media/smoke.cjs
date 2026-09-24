#!/usr/bin/env node
'use strict';
// Real offline decoder smoke. Requires full FFmpeg + ffprobe; no network/API keys.
// FFMPEG_BIN=/isolated/ffmpeg FFPROBE_BIN=/isolated/ffprobe node tests/media/smoke.cjs
// A missing binary is a FAILURE (exit 1), never a skipped/passing smoke check.
const fs=require('fs').promises;
const path=require('path');
const {spawnSync}=require('child_process');
const assert=require('assert/strict');
const {createWorkspace}=require('../../lib/media/publicMediaDownload');
const {processMedia,runLocalProcess}=require('../../lib/media/mediaProcess');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');
const {selectFrames}=require('../../lib/media/frameSelector');
const deps={ffmpegPath:process.env.FFMPEG_BIN || 'ffmpeg',ffprobePath:process.env.FFPROBE_BIN || 'ffprobe'};
(async()=>{
  for(const binary of Object.values(deps)) {
    const check=spawnSync(binary,['-version'],{encoding:'utf8',timeout:5000});
    if(check.error || check.status!==0)throw new Error(`Required media binary unavailable: ${path.basename(binary)}`);
    process.stdout.write(check.stdout.split('\n')[0]+'\n');
  }
  const media={...await createWorkspace(),container:'mp4'};
  try {
    media.path=path.join(media.directory,'source.media');
    await runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=3',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=3','-vf',
      "drawbox=x=50:y=40:w=180:h=60:color=white:t=fill:enable='between(t,1.2,1.5)'",'-c:v','mpeg4','-c:a','aac',
      '-shortest','-f','mp4',media.path],{deadline:Date.now()+15000});
    media.contentDigest=require('crypto').createHash('sha256').update(await fs.readFile(media.path)).digest('hex');
    const processed=await processMedia({media,deadline:Date.now()+20000},deps);
    assert.equal(processed.hasAudio,true);assert(processed.durationMs>=2900 && processed.durationMs<=3100);
    const audio=await prepareAudioChunks({media,processed,deadline:Date.now()+20000},deps);
    assert(audio.length>0);assert.equal(audio[0].audioBytes.toString('ascii',8,12),'WAVE');
    const result=await selectFrames({media,processed,deadline:Date.now()+25000,limit:16},deps);
    assert(result.frames.length>0);assert(result.frames.some(frame=>frame.timestampMs>=1200 && frame.timestampMs<=1500),'brief generated visual clue missed');
    assert(result.frames.every(frame=>frame.bytes.length>24 && frame.bytes.length<=1536*1024));
    const highDetail=await require('./high-detail-smoke.cjs')(media,deps);
    const adversarial=await require('./adversarial-smoke.cjs')(media,deps);
    process.stdout.write(JSON.stringify({ok:true,durationMs:processed.durationMs,chunks:audio.length,
      scannedFrames:result.scannedFrames,selectedTimestampsMs:result.frames.map(f=>f.timestampMs),highDetail,adversarial})+'\n');
  } finally {await media.dispose();}
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
