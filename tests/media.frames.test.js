'use strict';
jest.mock('../lib/providerRuntime',()=>({withProvider:(_p,work)=>work(),withLease:(_key,work)=>work()}));
const fs=require('fs').promises;
const os=require('os');
const path=require('path');
const {analyzeGrayFrame,hammingDistance}=require('../lib/media/textRegions');
const {scanFrames,rankFrames,parseFramePts,selectFrames,frameDimensions,pngCollector,MAX_FRAME_BYTES}=require('../lib/media/frameSelector');
const {createWorkspace}=require('../lib/media/publicMediaDownload');
function gray(sign=false,seed=0) {const b=Buffer.alloc(32*18,40);if(sign)for(let y=4;y<12;y++)for(let x=4;x<28;x++)b[y*32+x]=(x+seed)%3?235:25;return b;}
function info(n,time,width=32,height=18) {return `[Parsed_showinfo_6 @ 0x123] n: ${n} pts: ${n*123} pts_time:${time} duration: 0 fmt:gray sar:1/1 s:${width}x${height} i:P iskey:1 type:I\n`;}
function png(width=32,height=18) {
  const bytes=Buffer.alloc(45);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
  bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);bytes.write('IEND',37);
  return bytes;
}
test.each([[1280,1280],[3840,2160],[2160,3840],[127,123],[1,3840]])('RGB geometry %sx%s fits even high-detail frames without depending on compression', (width,height)=>{
  const size=frameDimensions(width,height,1280);
  expect(Math.max(size.width,size.height)).toBeLessThanOrEqual(1280);
  expect(size.width*size.height*3).toBeLessThanOrEqual(MAX_FRAME_BYTES-64*1024);
  expect(Math.abs(size.width/size.height-width/height)).toBeLessThanOrEqual(2/size.height);
  expect(MAX_FRAME_BYTES*8).toBeLessThanOrEqual(12*1024*1024);
});
test('oversized PNG chunks are rejected before buffering their payload, independently of dimension bounds',()=>{
  const header=png().subarray(0,16);header.writeUInt32BE(MAX_FRAME_BYTES,8);
  expect(()=>pngCollector(1).push(header)).toThrow(expect.objectContaining({code:'input_too_large',stage:'frame_selection'}));
});
test.each(['oversized','truncated','missing','process'])('a %s encoder output cannot become an empty complete scan or trigger retries',async kind=>{
  const release=jest.fn(async()=>{}),media={retain:()=>release,assertQuota:jest.fn()},calls=[];
  const run=async options=>{
    calls.push(options);
    if(calls.length===1){options.onStdout(gray(true));return {stderr:info(0,0.12)};}
    if(kind==='process')throw new (require('../lib/engineError').EngineError)('dependency_error',{stage:'media_decode'});
    const bytes=png();
    if(kind==='oversized'){bytes.writeUInt32BE(MAX_FRAME_BYTES,8);options.onStdout(bytes.subarray(0,16));}
    if(kind==='truncated')options.onStdout(bytes.subarray(0,40));
    return {stderr:info(0,0.12)};
  };
  await expect(selectFrames({media,processed:{videoStreamIndex:0,width:32,height:18,durationMs:1000,clipStartMs:0,clipEndMs:1000}},
    {runFfmpeg:run})).rejects.toHaveProperty('name','EngineError');
  expect(calls).toHaveLength(2);expect(release).toHaveBeenCalledTimes(1);
});
test('heuristics detect a brief new static overlay without a scene cut',()=>{
  const a=analyzeGrayFrame(gray(),32,18),b=analyzeGrayFrame(gray(true),32,18,a);
  expect(b.novelRegionScore).toBeGreaterThan(a.novelRegionScore);expect(b.clarity).toBeGreaterThan(a.clarity);
  expect(hammingDistance(b.perceptualHash,b.perceptualHash)).toBe(0);
});
test('showinfo parser preserves nonuniform PTS rather than nominal frame index',()=>{
  expect(parseFramePts(info(0,0.04)+info(1,0.217)+info(2,0.302)).map(p=>p.timestampMs)).toEqual([40,217,302]);
});
test('eight-bin coverage prevents sharp opening frames from starving late venues',()=>{
  const candidates=Array.from({length:80},(_,i)=>({timestampMs:i*100,score:i<10?1:0.2,clarity:0.5,
    digest:String(i).padStart(64,'0'),perceptualHash:BigInt(i*777777).toString(16).padStart(16,'0')}));
  const selected=rankFrames(candidates,{endMs:8000,limit:8});
  expect(new Set(selected.map(f=>Math.floor(f.timestampMs/1000))).size).toBe(8);
  expect(rankFrames(candidates.slice().reverse(),{endMs:8000,limit:8})).toEqual(selected);
});
test('near-identical frames prefer sharper frame and exact hashes are not repeated',()=>{
  const one={timestampMs:100,score:0.3,clarity:0.1,digest:'a'.repeat(64),perceptualHash:'0000000000000000'};
  const two={...one,timestampMs:200,score:0.6,clarity:0.8,digest:'b'.repeat(64)};
  const again={...two,timestampMs:900};
  expect(rankFrames([one,two,again],{endMs:8000,limit:8})).toEqual([two]);
});
test('scan streams grayscale bytes and attaches actual clipped timeline offsets',async()=>{
  const run=jest.fn(async options=>{options.onStdout(Buffer.concat([gray(),gray(true)]));return {stderr:info(0,1.02)+info(1,1.29)};});
  const result=await scanFrames({media:{},processed:{videoStreamIndex:0,width:32,height:18,clipStartMs:1000,clipEndMs:1600}},{runFfmpeg:run});
  expect(result.candidates.map(c=>c.timestampMs)).toEqual([1020,1290]);
  expect(run.mock.calls[0][0].args.join(' ')).toContain('scdet=threshold=10');
  expect(run.mock.calls[0][0].args.join(' ')).toContain('0.166666');
  expect(result.candidates[1].novelRegionScore).toBeGreaterThan(0);
});
test('mismatched decoder timestamps cannot be substituted with guessed times',async()=>{
  await expect(scanFrames({media:{},processed:{videoStreamIndex:0,width:32,height:18,clipStartMs:0,clipEndMs:1000}},
    {runFfmpeg:async options=>{options.onStdout(gray());return {stderr:''};}})).rejects.toMatchObject({code:'invalid_response'});
});
test('removed final-digest exclusion API fails explicitly, never hides replacement candidates',async()=>{
  const run=jest.fn();await expect(selectFrames({media:{},processed:{},excludeDigests:[]},{runFfmpeg:run}))
    .rejects.toMatchObject({code:'invalid_response',stage:'frame_selection'});expect(run).not.toHaveBeenCalled();
});
test('final byte output is hashed, geometry verified and operation files removed',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'frame-output-')),media=await createWorkspace({root});media.contentDigest='d'.repeat(64);
  try {
    let calls=0;
    const run=jest.fn(async options=>{
      if(calls++===0){options.onStdout(gray(true));return {stderr:info(0,0.12)};}
      const bytes=png();
      options.onStdout(bytes.subarray(0,19));options.onStdout(bytes.subarray(19));return {stderr:info(0,0.12)};
    });
    const result=await selectFrames({media,processed:{videoStreamIndex:0,width:32,height:18,durationMs:1000,clipStartMs:0,clipEndMs:1000}},{runFfmpeg:run});
    expect(result.frames[0]).toMatchObject({width:32,height:18,timestampMs:120,mimeType:'image/png',sourceDigest:'d'.repeat(64)});
    expect(result.frames[0].digest).toMatch(/^[a-f0-9]{64}$/);expect(result.additionalFramesAvailable).toBe(false);
    expect(run.mock.calls[1][0].maxStdoutBytes).toBe(MAX_FRAME_BYTES);
    expect(run.mock.calls[1][0].args.join(' ')).toContain('format=rgb24');
    for(const [options] of run.mock.calls)expect(options.args).toEqual(expect.arrayContaining(['-map','0:0']));
    expect((await fs.readdir(media.directory)).filter(f=>f.startsWith('frame-'))).toEqual([]);
  } finally {await media.dispose();await fs.rm(root,{recursive:true,force:true});}
});
