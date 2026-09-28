'use strict';
// Compare real PNG decodes, not container hashes: prediction/compression may
// change bytes, but must not change selected frames, timing or visible pixels.
const fs=require('fs').promises;
const path=require('path');
const assert=require('assert/strict');
const {createHash,randomUUID}=require('crypto');
const {runFfmpeg,runLocalProcess}=require('../../lib/media/mediaProcess');
const {selectFrames}=require('../../lib/media/frameSelector');

async function pixels(media,frames,deps) {
  const file=path.join(media.directory,`pixel-check-${randomUUID()}.pngs`);
  const expectedBytes=frames.reduce((n,f)=>n+f.width*f.height*3,0);
  const hash=createHash('sha256');let bytes=0;
  try {
    await fs.writeFile(file,Buffer.concat(frames.map(f=>f.bytes)),{flag:'wx',mode:0o600});
    await media.assertQuota();
    await runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner','-xerror','-threads','1',
      '-protocol_whitelist','file','-f','image2pipe','-c:v','png','-i',file,
      '-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],
    {deadline:Date.now()+30000,cwd:media.directory,workspace:media,maxStdoutBytes:expectedBytes,
      onStdout:chunk=>{bytes+=chunk.length;hash.update(chunk);}});
    assert.equal(bytes,expectedBytes,'all selected RGB frames must decode');
    return hash.digest('hex');
  } finally {await fs.rm(file,{force:true});}
}

module.exports=async function losslessSmoke(media,processed,deps,selected,limit=16) {
  const current=selected || await selectFrames({media,processed,deadline:Date.now()+30000,limit},deps);
  const legacy=await selectFrames({media,processed,deadline:Date.now()+30000,limit},{...deps,
    runFfmpeg:options=>{
      if(options.stage==='frame_encode') {
        const args=[...options.args],prediction=args.indexOf('-pred');
        if(prediction!==-1)args.splice(prediction,2);
        args[args.indexOf('-compression_level')+1]='3';
        options={...options,args};
      }
      return runFfmpeg(options,deps);
    }});
  const metadata=result=>({scannedFrames:result.scannedFrames,policy:result.policy,coverage:result.coverage,
    frames:result.frames.map(({width,height,timestampMs,selectionReasons,crop})=>({width,height,timestampMs,selectionReasons,crop}))});
  assert.deepEqual(metadata(current),metadata(legacy),'selection, geometry and timing must remain identical');
  assert.equal(await pixels(media,current.frames,deps),await pixels(media,legacy.frames,deps),
    'lossless compression must preserve every decoded pixel');
  return {frames:current.frames.length,pixelsIdentical:true,timestampsIdentical:true,
    legacyBytes:legacy.frames.reduce((n,f)=>n+f.bytes.length,0),currentBytes:current.frames.reduce((n,f)=>n+f.bytes.length,0)};
};
