#!/usr/bin/env node
'use strict';
// Real generated-only VFR/rotation/clip/brief-overlay checks. No network, user media or providers.
const fs=require('fs').promises;
const path=require('path');
const assert=require('assert/strict');
const {createHash}=require('crypto');
const {createWorkspace}=require('../../lib/media/publicMediaDownload');
const {processMedia,runLocalProcess}=require('../../lib/media/mediaProcess');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');
const {scanFrames,selectFrames}=require('../../lib/media/frameSelector');
const deps={ffmpegPath:process.env.FFMPEG_BIN || 'ffmpeg',ffprobePath:process.env.FFPROBE_BIN || 'ffprobe'};
const generate=args=>runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner',...args],{deadline:Date.now()+20000});
(async()=>{
  const workspace=await createWorkspace({root:process.env.MEDIA_SMOKE_ROOT});
  const report=[];
  async function open(filename) {
    const file=path.join(workspace.directory,filename);
    return {...workspace,path:file,container:'mp4',contentDigest:createHash('sha256').update(await fs.readFile(file)).digest('hex')};
  }
  async function inspect(name,filename,clip,expectRotation=false) {
    const media=await open(filename),deadline=Date.now()+30000;
    const processed=await processMedia({media,deadline,clip},deps);
    if(expectRotation){assert.equal(processed.rotation,90);assert.equal(processed.width,180);assert.equal(processed.height,320);}
    const result=await selectFrames({media,processed,deadline,limit:16},deps);
    assert(result.frames.length>0);
    assert(result.frames.every(f=>f.timestampMs>=processed.clipStartMs && f.timestampMs<processed.clipEndMs));
    assert(result.frames.some(f=>f.timestampMs>=1200 && f.timestampMs<1500),'0.3s generated overlay was not selected');
    if(expectRotation)assert(result.frames.every(f=>f.width===180 && f.height===320));
    if(!processed.hasAudio)assert.deepEqual(await prepareAudioChunks({media,processed,deadline},deps),[]);
    report.push({case:name,durationMs:processed.durationMs,rotation:processed.rotation,hasAudio:processed.hasAudio,
      clip:[processed.clipStartMs,processed.clipEndMs],scannedFrames:result.scannedFrames,selectedTimestampsMs:result.frames.map(f=>f.timestampMs)});
    return {media,processed};
  }
  try {
    const base=path.join(workspace.directory,'base.mp4'),vfr=path.join(workspace.directory,'vfr.mp4'),rotated=path.join(workspace.directory,'rotated.mp4');
    await generate(['-f','lavfi','-i','color=c=black:s=320x180:r=30:d=3','-vf',
      "drawbox=x=80:y=50:w=40:h=12:color=white:t=fill:enable='gte(t,1.2)*lt(t,1.5)'",'-an','-c:v','mpeg4','-q:v','2','-f','mp4',base]);
    const basic=await inspect('small-static-overlay-no-audio','base.mp4');
    const scan=await scanFrames({media:basic.media,processed:basic.processed,deadline:Date.now()+20000},deps);
    assert(scan.candidates.filter(f=>f.timestampMs>=1200 && f.timestampMs<1500).every(f=>f.sceneScore<0.1),
      'fixture should exercise an overlay below the scene-cut threshold');
    await generate(['-i',base,'-an','-vf',"select='if(lt(t,1),not(mod(n,2)),not(mod(n,3)))'",'-fps_mode','vfr','-c:v','mpeg4','-q:v','2','-f','mp4',vfr]);
    const packetResult=await runLocalProcess(deps.ffprobePath,['-v','error','-select_streams','v:0','-show_frames',
      '-show_entries','frame=best_effort_timestamp_time','-of','json',vfr],{deadline:Date.now()+10000});
    const pts=JSON.parse(packetResult.stdout).frames.map(f=>Number(f.best_effort_timestamp_time)*1000);
    const steps=[...new Set(pts.slice(1).map((t,i)=>Math.round(t-pts[i])))];
    assert(steps.length>=2,'generated fixture unexpectedly became constant-frame-rate');
    await inspect('variable-frame-rate','vfr.mp4');report.at(-1).sourcePtsStepsMs=steps;
    await generate(['-display_rotation:v:0','90','-i',vfr,'-c','copy','-f','mp4',rotated]);
    await inspect('rotation-90-vfr','rotated.mp4',null,true);
    await inspect('clip-offsets-on-rotated-vfr','rotated.mp4',{startMs:700,endMs:2300},true);
    // A renamed local playlist cannot cause the decoder to open network references.
    const hostile=path.join(workspace.directory,'not-video.mp4');await fs.writeFile(hostile,'#EXTM3U\nhttps://127.0.0.1/private\n');
    await assert.rejects(()=>processMedia({media:{...workspace,path:hostile,container:'mp4'},deadline:Date.now()+5000},deps));
    report.push({case:'disguised-playlist',rejected:true});
    report.push(await require('./high-detail-smoke.cjs')(workspace,deps));
    report.push(...await require('./adversarial-smoke.cjs')(workspace,deps));
    console.log(JSON.stringify({ok:true,cases:report},null,2));
  } finally {await workspace.dispose();}
})().catch(error=>{console.error(error.stack || error.message);process.exitCode=1;});
