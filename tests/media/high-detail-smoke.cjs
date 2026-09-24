'use strict';
// Real incompressible RGB fixture. Built-in codecs only; no user media/network/Jest dependency.
const fs=require('fs').promises;
const path=require('path');
const assert=require('assert/strict');
const {createHash}=require('crypto');
const {runLocalProcess,processMedia}=require('../../lib/media/mediaProcess');
const {selectFrames,MAX_FRAME_BYTES}=require('../../lib/media/frameSelector');

module.exports=async function highDetailSmoke(workspace,deps) {
  const raw=path.join(workspace.directory,'noise.rgb'),file=path.join(workspace.directory,'noise.mov');
  let state=0x12345678;
  const handle=await fs.open(raw,'wx',0o600);
  try {
    for(let frame=0;frame<8;frame++) {
      const bytes=Buffer.alloc(1280*1280*3);
      for(let i=0;i<bytes.length;i++) {state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}
      await handle.writeFile(bytes);
    }
  } finally {await handle.close();}
  try {
    await runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner','-f','rawvideo','-pixel_format','rgb24',
      '-video_size','1280x1280','-framerate','2','-i',raw,'-an','-threads','1','-c:v','png','-compression_level','3','-f','mov',file],
    {deadline:Date.now()+30000,workspace});
    // Confirm the unchanged full-size source frame genuinely exceeds the adapter cap.
    const probe=await runLocalProcess(deps.ffprobePath,['-v','error','-select_streams','v:0','-show_packets',
      '-show_entries','packet=size','-of','json',file],{deadline:Date.now()+10000});
    const sourceBytes=JSON.parse(probe.stdout).packets.map(packet=>Number(packet.size));
    assert(sourceBytes.every(bytes=>bytes>2*1024*1024),'fixture must exceed the previous vision per-frame limit');
    await fs.unlink(raw);
    const media={...workspace,path:file,container:'mp4',contentDigest:createHash('sha256').update(await fs.readFile(file)).digest('hex')};
    const processed=await processMedia({media,deadline:Date.now()+10000},deps);
    const selected=await selectFrames({media,processed,deadline:Date.now()+30000,limit:8},deps);
    assert.equal(selected.frames.length,8,'eight distinct noisy frames should survive normalization');
    let total=0;
    for(const frame of selected.frames) {
      assert(frame.bytes.length<=MAX_FRAME_BYTES);total+=frame.bytes.length;
      assert.equal(frame.width,frame.bytes.readUInt32BE(16));assert.equal(frame.height,frame.bytes.readUInt32BE(20));
      assert(frame.width<1280 && frame.height<1280);assert.equal(frame.width,frame.height);
      assert.equal(frame.bytes[24],8);assert.equal(frame.bytes[25],2,'PNG must be 8-bit RGB, not alpha/high-bit-depth');
      assert.equal(frame.digest,createHash('sha256').update(frame.bytes).digest('hex'));
    }
    assert(total<=12*1024*1024);await workspace.assertQuota();
    return {case:'high-detail-eight-frame-batch',sourceFrameMinBytes:Math.min(...sourceBytes),
      selectedFrames:selected.frames.length,maxFrameBytes:Math.max(...selected.frames.map(f=>f.bytes.length)),batchBytes:total,
      width:selected.frames[0].width,height:selected.frames[0].height};
  } finally {await fs.rm(raw,{force:true});await fs.rm(file,{force:true});}
};
