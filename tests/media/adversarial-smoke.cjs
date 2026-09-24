'use strict';
// Generated-only regression cases for decoder damage, audio PTS gaps and stream binding.
const fs=require('fs').promises;
const path=require('path');
const assert=require('assert/strict');
const {createHash}=require('crypto');
const {runLocalProcess,processMedia}=require('../../lib/media/mediaProcess');
const {selectFrames,scanFrames}=require('../../lib/media/frameSelector');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');

module.exports=async function adversarialSmoke(workspace,deps) {
  const owned=[],report=[];
  const filename=name=>{const file=path.join(workspace.directory,name);owned.push(file);return file;};
  const generate=args=>runLocalProcess(deps.ffmpegPath,['-nostdin','-hide_banner',...args],{deadline:Date.now()+30000,workspace});
  async function open(file) {
    const media={...workspace,path:file,container:'mp4',contentDigest:createHash('sha256').update(await fs.readFile(file)).digest('hex')};
    return {media,processed:await processMedia({media,deadline:Date.now()+10000},deps),deadline:Date.now()+30000};
  }
  try {
    const multi=filename('multiple-video.mov');
    await generate(['-f','lavfi','-i','color=c=black:s=320x180:r=2:d=1',
      '-f','lavfi','-i','color=c=white:s=5000x1000:r=2:d=1','-map','0:v:0','-map','1:v:0',
      '-threads','1','-c:v','png','-f','mov',multi]);
    const multiple=await open(multi);
    assert.equal(multiple.processed.videoStreamIndex,0);
    assert.equal(multiple.processed.width,320);assert.equal(multiple.processed.height,180);
    const selected=await selectFrames({...multiple,limit:8},deps);
    assert(selected.frames.length>0);assert(selected.frames.every(f=>f.width===320 && f.height===180));
    report.push({case:'explicit-video-stream',validatedStream:multiple.processed.videoStreamIndex,
      ignoredStreamDimensions:[5000,1000],encodedDimensions:[selected.frames[0].width,selected.frames[0].height]});

    const gap=filename('audio-gap.mp4');
    await generate(['-f','lavfi','-i','color=c=black:s=320x180:r=2:d=15',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=15','-af',"aselect='lt(t,5)+gte(t,10)'",
      '-threads','1','-c:v','mpeg4','-c:a','aac','-f','mp4',gap]);
    // PCM-in-MOV flattens timestamp gaps while muxing; AAC-in-MP4 retains this discontinuity.
    const audioPackets=await runLocalProcess(deps.ffprobePath,['-v','error','-select_streams','a:0','-show_packets',
      '-show_entries','packet=pts_time','-of','json',gap],{deadline:Date.now()+10000});
    const audioPts=JSON.parse(audioPackets.stdout).packets.map(p=>Number(p.pts_time));
    assert(audioPts.some((t,i)=>i>0 && t-audioPts[i-1]>4),'fixture must retain an actual five-second PTS gap');
    const gapInput=await open(gap);
    await assert.rejects(()=>prepareAudioChunks(gapInput,deps),{code:'invalid_response',stage:'audio_timeline'});
    await assert.rejects(()=>prepareAudioChunks({...gapInput,subtitles:{segments:[{startMs:0,endMs:5000,text:'Only the opening speech'}],
      coverage:{status:'partial',intervals:[[0,5000]]}}},deps),{code:'invalid_response',stage:'audio_timeline'});
    report.push({case:'audio-pts-gap',rejected:true,subtitleReuseAlsoRejected:true});

    const fragmented=filename('fragmented-subtitles.mp4');
    await generate(['-f','lavfi','-i','color=c=black:s=320x180:r=2:d=15',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=15',
      '-threads','1','-c:v','mpeg4','-c:a','aac','-f','mp4',fragmented]);
    const fragmentInput=await open(fragmented);
    const cues=Array.from({length:100},(_,i)=>({text:`cue ${i}`,startMs:i*100,endMs:i*100+40}));
    const subtitles={segments:cues,coverage:{status:'partial',intervals:cues.map(c=>[c.startMs,c.endMs])}};
    const chunks=await prepareAudioChunks({...fragmentInput,subtitles},deps);
    assert.equal(chunks.length,1);assert.equal(chunks[0].startMs,0);assert.equal(chunks[0].endMs,15000);
    assert.equal(chunks[0].audioBytes.readUInt32LE(40),15000*32);
    assert.equal(chunks[0].audioBytes.length,44+15000*32);
    assert.deepEqual(require('../../lib/media/audioSegments').missingIntervals([
      ...subtitles.coverage.intervals,...chunks.map(c=>[c.startMs,c.endMs])],fragmentInput.processed.durationMs),[]);
    report.push({case:'100-subtitle-gaps',subtitleCues:cues.length,audioChunks:chunks.length,
      decodedIntervals:chunks.map(c=>[c.startMs,c.endMs])});

    const damaged=filename('damaged-video.mp4');
    await generate(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=2','-an','-threads','1','-c:v','mpeg4','-g','10','-q:v','3','-f','mp4',damaged]);
    const packetResult=await runLocalProcess(deps.ffprobePath,['-v','error','-show_packets','-select_streams','v:0',
      '-show_entries','packet=pos,size,flags','-of','json',damaged],{deadline:Date.now()+10000});
    const packet=JSON.parse(packetResult.stdout).packets.filter(p=>p.flags.includes('K'))[2];
    assert(packet,'fixture must include a later key frame');
    const bytes=await fs.readFile(damaged),lo=Number(packet.pos)+Math.floor(Number(packet.size)/2),hi=Number(packet.pos)+Number(packet.size)-8;
    bytes.fill(0,lo,hi);await fs.writeFile(damaged,bytes);
    // Establish this is the regression: permissive FFmpeg exits zero despite reported damage.
    const permissive=await generate(['-v','error','-i',damaged,'-an','-f','null','-']);
    assert(/error|damaged|invalid|corrupt/i.test(permissive.stderr),'fixture did not produce recoverable decode damage');
    const damagedInput=await open(damaged);
    await assert.rejects(()=>scanFrames(damagedInput,deps),{code:'invalid_response',stage:'media_decode'});
    report.push({case:'recoverable-video-corruption',permissiveExit:0,strictRejected:true});
    return report;
  } finally {for(const file of owned)await fs.rm(file,{force:true});}
};
