'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {mediaFromYtDlp}=require('../../lib/media/mediaSource');
const {runLocalProcess,processMedia}=require('../../lib/media/mediaProcess');
const {selectFrames}=require('../../lib/media/frameSelector');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');

// Real offline 720p selection + separate AAC alignment using the same brief
// 300ms visual clue and audio as the main generated smoke. No CDN/AI calls.
module.exports=async function renditionSelectionSmoke(media,deps) {
  const file=path.join(media.directory,'bounded720.media');
  await runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner','-threads','1','-filter_threads','1',
    '-i',media.path,'-map','0:v:0','-vf','scale=1280:720','-c:v','libx264','-threads','1','-preset','ultrafast',
    '-crf','20','-an','-f','mp4',file],{deadline:Date.now()+20000});
  const post='https://www.instagram.com/reel/SMOKE720/';
  const descriptor=mediaFromYtDlp({webpage_url:post,formats:[
    {url:'https://cdn.example/unknown',ext:'mp4',protocol:'https',vcodec:'h264'},
    {url:'https://cdn.example/bounded720',ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none',width:1280,height:720},
    {url:'https://cdn.example/audio',ext:'m4a',protocol:'https',vcodec:'none',acodec:'aac'},
  ]},post);
  assert.equal(descriptor.renditions[0].url,'https://cdn.example/bounded720');
  assert.equal(descriptor.durationMs,null); // Observed Instagram metadata shape.
  assert(descriptor.audioRendition);
  const video={...media,path:file,contentDigest:createHash('sha256').update(await fs.readFile(file)).digest('hex')};
  const processed=await processMedia({media:video,deadline:Date.now()+10000},deps);
  assert.equal(processed.hasAudio,false);assert.equal(processed.width,1280);assert.equal(processed.height,720);
  const audioPath=path.join(media.directory,'bounded720-audio.media');
  await runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner','-i',media.path,'-map','0:a:0','-c','copy','-f','mp4',audioPath],{deadline:Date.now()+10000});
  const audio={...media,path:audioPath,contentDigest:createHash('sha256').update(await fs.readFile(audioPath)).digest('hex')};
  const audioInfo=await processMedia({media:audio,audioForVideo:processed,deadline:Date.now()+10000},deps);
  const chunks=await prepareAudioChunks({media:audio,processed:audioInfo,deadline:Date.now()+15000},deps);
  assert(chunks.length>0);assert(chunks.every(c=>c.startMs>=0 && c.endMs<=processed.clipEndMs));
  const result=await selectFrames({media:video,processed,deadline:Date.now()+25000,limit:16},deps);
  assert(result.frames.some(f=>f.timestampMs>=1200 && f.timestampMs<=1500),'bounded rendition lost the brief visual clue');
  // The existing worst-case PNG byte bound encodes a 16:9 720p/1080p
  // source at 945x531. Selection must not substitute scan-size (320px) frames.
  assert(result.frames.every(f=>f.width===945 && f.height===531),'existing final-frame geometry changed');
  return {width:processed.width,height:processed.height,audioChunks:chunks.length,
    selectedTimestampsMs:result.frames.map(f=>f.timestampMs),encodedWidth:945,encodedHeight:531,briefClueRetained:true};
};
