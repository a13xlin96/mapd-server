'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {processMedia,runLocalProcess,localInputArgs}=require('../../lib/media/mediaProcess');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');
const FIXTURES={
 'aac-priming-5058.m4a':'a30d2df796434497ac0bd0d2f69692dde2e4e9fbcece546076703b7324273b7e',
 'zero-origin-video.mp4':'eed3aa1c988b23177b5c2a6f545f8f3f7c030e6418afd8b8a231c987bbb906a8',
};
// These same fixed synthetic bytes must be read in every environment. Generating
// AAC in the tested runtime hides the older demuxer's fragmented-edit-list bug.
module.exports=async function primingSmoke(workspace,deps) {
 const load=async name=>{
  const bytes=await fs.readFile(path.join(__dirname,'fixtures',name));
  const digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest,FIXTURES[name],`unexpected fixture bytes: ${name}`);
  const file=path.join(workspace.directory,name);await fs.writeFile(file,bytes,{flag:'wx'});
  return {...workspace,path:file,container:'mp4',contentDigest:digest};
 };
 const video=await load('zero-origin-video.mp4'),audio=await load('aac-priming-5058.m4a');
 const videoInfo=await processMedia({media:video,deadline:Date.now()+10000},deps);
 assert.equal(videoInfo.hasAudio,false);assert.equal(videoInfo.startMs,0);assert.equal(videoInfo.durationMs,3000);
 const audioInfo=await processMedia({media:audio,audioForVideo:videoInfo,deadline:Date.now()+10000},deps);
 assert.equal(audioInfo.audioStartMs,0);assert.equal(audioInfo.separateAudio.originMs,0);
 const raw=await runLocalProcess(deps.ffprobePath,['-v','error',...localInputArgs(audio),
  '-select_streams','a:0','-read_intervals','%+#1','-show_packets','-of','json'],
  {cwd:audio.directory,deadline:Date.now()+10000,maxStdoutBytes:16384});
 const packet=JSON.parse(raw.stdout).packets[0];
 assert.equal(packet.pts,-5058,'fixture no longer exercises AAC preroll');
 const skip=packet.side_data_list?.find(s=>s.side_data_type==='Skip Samples');
 assert.equal(skip?.skip_samples,5058,'decoder must honor the edit-list priming samples');
 const chunks=await prepareAudioChunks({media:audio,processed:audioInfo,deadline:Date.now()+10000},deps);
 assert.equal(chunks.length,1);assert.equal(chunks[0].startMs,0);assert.equal(chunks[0].endMs,3000);
 assert.equal(chunks[0].audioBytes.length,44+3*16000*2,'continuous, unpadded PCM must cover the video');
 // Check that real samples survived, not a zero-filled or discarded audio track.
 const pcm=chunks[0].audioBytes.subarray(44);let energy=0;
 for(let i=0;i<pcm.length;i+=2)energy+=pcm.readInt16LE(i)**2;
 assert(Math.sqrt(energy/(pcm.length/2))>100,'synthetic tone lost');
 return {fixedFixtures:true,skippedPrimingSamples:5058,audioStartMs:0,audioEndMs:3000,continuousPcm:true};
};
