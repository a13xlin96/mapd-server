'use strict';
jest.mock('../lib/providerRuntime',()=>({withProvider:(_p,work)=>work(),withLease:(_key,work)=>work()}));
const fs=require('fs');
const fsp=fs.promises;
const os=require('os');
const path=require('path');
const {EventEmitter}=require('events');
const {Readable}=require('stream');
const dns=require('dns').promises;
const {createMediaDescriptor,attachMediaDescriptor,discoverMediaSource,mediaFromYtDlp}=require('../lib/media/mediaSource');
const {acquireMedia,acquireSeparateAudio,downloadPublicMedia,createWorkspace,sweepOrphanWorkspaces,sniffContainer}=require('../lib/media/publicMediaDownload');
const {parseInstagramPost}=require('../lib/postMetadata');
const {parseSubtitleCues}=require('../lib/ytdlp');
const sourceUrl='https://www.instagram.com/reel/SYNTHETIC/';
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex');
let root;
function transport(replies,assertOptions=()=>{}) {
  return jest.fn((url,options,cb)=>{
    assertOptions(url,options);
    const req=new EventEmitter();
    req.end=()=>setImmediate(()=>{
      const next=replies.shift();if(next instanceof Error)return req.emit('error',next);
      const response=Readable.from(next.chunks || [mp4]);response.statusCode=next.status || 200;response.headers=next.headers || {};
      cb(response);
    });return req;
  });
}
beforeEach(async()=>{root=await fsp.mkdtemp(path.join(os.tmpdir(),'media-test-'));jest.spyOn(dns,'lookup').mockResolvedValue([{address:'93.184.216.34',family:4}]);});
afterEach(async()=>{jest.restoreAllMocks();await fsp.rm(root,{recursive:true,force:true});});
test('post-scoped renditions stay out of serialized metadata and reject playlists',()=>{
  const descriptor=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/video.mp4',format:'mp4'},{url:'https://cdn.example/master.m3u8',format:'mp4'}]});
  const data=attachMediaDescriptor({description:''},descriptor);
  expect(data.mediaDescriptor.renditions).toHaveLength(1);
  expect(JSON.stringify(data)).toBe('{"description":"","mediaAvailable":true}');
  expect(()=>Object.assign({},data).mediaDescriptor).not.toThrow();
  expect(mediaFromYtDlp({is_live:true,formats:[{url:'https://cdn.example/video.mp4',ext:'mp4'}]},sourceUrl).availability).toBe('unavailable');
});
test('matching post only exposes media; unrelated recommended post does not',()=>{
  const html='<script>'+JSON.stringify({items:[{shortcode:'OTHER',video_url:'https://cdn.example/wrong.mp4'},{shortcode:'SYNTHETIC',video_versions:[{url:'https://cdn.example/right.mp4'}]}]})+'</script>';
  expect(parseInstagramPost(html,'SYNTHETIC').mediaRenditions).toEqual([{url:'https://cdn.example/right.mp4',format:'mp4',hasAudio:null,width:undefined,height:undefined}]);
});
test('captionless evidenced muxed media needs no extra metadata reader',async()=>{
  const descriptor=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/video.mp4',format:'mp4',hasAudio:true}]});
  const runYtDlp=jest.fn();
  expect(await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({},descriptor)},{runYtDlp})).toBe(descriptor);
  expect(runYtDlp).not.toHaveBeenCalled();
});
test.each([undefined,true,false])('post-level has_audio=%s does not fabricate per-URL audio presence',has_audio=>{
  const metadata=parseInstagramPost('<script>'+JSON.stringify({shortcode:'SYNTHETIC',has_audio,
    video_url:'https://cdn.example/top.mp4',video_versions:[{url:'https://cdn.example/version.mp4'}]})+'</script>','SYNTHETIC');
  expect(metadata.mediaRenditions.map(r=>r.hasAudio)).toEqual(has_audio === false ? [false,false] : [null,null]);
});
test('rendition-local boolean audio declaration is preserved, not a truthy string or unrelated post flag',()=>{
  const metadata=parseInstagramPost('<script>'+JSON.stringify({items:[{shortcode:'OTHER',has_audio:true},
    {shortcode:'SYNTHETIC',video_versions:[true,false,undefined,'true'].map((has_audio,i)=>({url:`https://cdn.example/${i}.mp4`,has_audio}))}]})+'</script>','SYNTHETIC');
  expect(metadata.mediaRenditions.map(r=>r.hasAudio)).toEqual([true,false,null,null]);
});
test('known audio outranks unknown then absent; missing and invalid heights never become ideal 720',()=>{
  const rendition=(name,hasAudio,height)=>({url:`https://cdn.example/${name}`,format:'mp4',hasAudio,height});
  const descriptor=createMediaDescriptor({url:sourceUrl,renditions:[
    rendition('missing',true),rendition('zero',true,0),rendition('unknown',null,720),
    rendition('absent',false,720),rendition('known',true,1080),rendition('best',true,720),
  ]});
  expect(descriptor.renditions.map(r=>r.url.split('/').at(-1))).toEqual(['best','known','missing','zero']);
  expect(descriptor.renditions[2].height).toBeNull();expect(descriptor.renditions[3].height).toBeNull();
  const ranked=createMediaDescriptor({url:sourceUrl,renditions:[rendition('absent',false,720),rendition('unknown',null,1080),rendition('known',true)]});
  expect(ranked.renditions.map(r=>r.hasAudio)).toEqual([true,null,false]);
});
test.each([undefined,null,'','unknown','N/A','?','none','aac'])('yt-dlp acodec=%s preserves known/unknown/absent',acodec=>{
  const descriptor=mediaFromYtDlp({webpage_url:sourceUrl,formats:[{url:'https://cdn.example/video',ext:'mp4',vcodec:'h264',acodec}]},sourceUrl);
  expect(descriptor.renditions[0].hasAudio).toBe(acodec==='aac' ? true : acodec==='none' ? false : null);
});
test('yt-dlp prefers evidenced muxed video and retains audio-only/adaptive exclusions',()=>{
  const f=(name,extra)=>({url:`https://cdn.example/${name}`,ext:'mp4',protocol:'https',...extra});
  const descriptor=mediaFromYtDlp({webpage_url:sourceUrl,formats:[
    f('unknown',{height:720,vcodec:'h264'}),f('video-only',{height:720,vcodec:'h264',acodec:'none'}),
    f('audio-only',{vcodec:'none',acodec:'aac'}),f('audio-unproven-video',{acodec:'aac'}),
    f('audio-m4a',{ext:'m4a',vcodec:'none',acodec:'aac'}),f('dash',{protocol:'http_dash_segments',vcodec:'h264',acodec:'aac'}),
    f('muxed',{height:1080,vcodec:'h264',acodec:'aac'}),
  ]},sourceUrl);
  expect(descriptor.renditions.map(r=>r.url.split('/').at(-1))).toEqual(['muxed','unknown','video-only']);
});
test('duplicate top-level unknown URL cannot override explicit audio absence or exhaust rendition bound',()=>{
  const common={url:'https://cdn.example/video-only',ext:'mp4'};
  const descriptor=mediaFromYtDlp({...common,webpage_url:sourceUrl,formats:[
    {...common,vcodec:'h264',acodec:'none',height:720},
    {url:'https://cdn.example/unknown',ext:'mp4',height:1080,vcodec:'h264'},
  ]},sourceUrl);
  expect(descriptor.renditions.map(r=>r.hasAudio)).toEqual([null,false]);
  expect(descriptor.renditions[1].height).toBe(720);
});
test.each([null,false])('HTML audio=%s permits one bounded metadata-only discovery before exactly one selected download',async hasAudio=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4',hasAudio}]});
  const available=mediaFromYtDlp({webpage_url:sourceUrl,formats:[{url:'https://cdn.example/muxed',ext:'mp4',vcodec:'h264',acodec:'aac'}]},sourceUrl);
  const runYtDlp=jest.fn().mockResolvedValue(attachMediaDescriptor({mediaDiscoveryAttempted:true},available));
  const deadline=Date.now()+10000;
  const descriptor=await discoverMediaSource({url:sourceUrl,deadline,config:{requestTimeoutMs:500},
    extracted:attachMediaDescriptor({},direct)},{runYtDlp});
  expect(descriptor).toBe(available);expect(runYtDlp).toHaveBeenCalledTimes(1);
  const options=runYtDlp.mock.calls[0][1];expect(options.mediaOnly).toBe(true);
  expect(options.deadline).toBeLessThanOrEqual(Date.now()+500);expect(options.deadline).toBeLessThanOrEqual(deadline);
  const request=transport([{}],url=>expect(String(url)).toBe('https://cdn.example/muxed'));
  const media=await acquireMedia({descriptor,root},{request});await media.dispose();
  expect(request).toHaveBeenCalledTimes(1);expect(runYtDlp).toHaveBeenCalledTimes(1);
});
test.each([null,false])('already-discovered direct audio=%s never starts another metadata reader',async hasAudio=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/video',format:'mp4',hasAudio}]});
  const runYtDlp=jest.fn();
  expect(await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({mediaDiscoveryAttempted:true},direct)},{runYtDlp})).toBe(direct);
  expect(runYtDlp).not.toHaveBeenCalled();
});
test.each(['rate_limited','access_blocked','dependency_timeout','attempt_stopped','dependency_error'])('unknown HTML discovery %s fails without downloading the HTML alternative',async code=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4'}]});
  const error=Object.assign(new Error('synthetic'),{code}),runYtDlp=jest.fn().mockRejectedValue(error);
  const request=transport([{}]);
  await expect((async()=>{
    const descriptor=await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({},direct)},{runYtDlp});
    return acquireMedia({descriptor,root},{request});
  })()).rejects.toBe(error);
  expect(runYtDlp).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();
});
test.each([{code:'rate_limited'},{code:'access_blocked'},{code:'dependency_timeout'},{status:429},{response:{status:403}}])('existing source failure prevents unknown-HTML discovery: %p',async sourceFailure=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4'}]});
  const runYtDlp=jest.fn();
  await expect(discoverMediaSource({url:sourceUrl,sourceFailure,extracted:attachMediaDescriptor({},direct)},{runYtDlp})).rejects.toBe(sourceFailure);
  expect(runYtDlp).not.toHaveBeenCalled();
});
test('discovery cannot donate another post or override live/carousel exclusions with HTML fallback',async()=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4'}]});
  const extracted=attachMediaDescriptor({},direct);
  const wrong=createMediaDescriptor({url:'https://www.instagram.com/reel/OTHER/',renditions:[{url:'https://cdn.example/wrong',format:'mp4',hasAudio:true}]});
  await expect(discoverMediaSource({url:sourceUrl,extracted},{runYtDlp:jest.fn().mockResolvedValue(attachMediaDescriptor({},wrong))})).rejects.toMatchObject({code:'source_unavailable'});
  for(const flags of [{isLive:true},{isCarousel:true}]) {
    const excluded=createMediaDescriptor({url:sourceUrl,...flags});
    expect(await discoverMediaSource({url:sourceUrl,extracted},{runYtDlp:jest.fn().mockResolvedValue(attachMediaDescriptor({},excluded))})).toBe(excluded);
  }
});
test('successful empty metadata discovery may retain same-post HTML video as unknown, without claiming audio',async()=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4'}]});
  const runYtDlp=jest.fn().mockResolvedValue(attachMediaDescriptor({},createMediaDescriptor({url:sourceUrl})));
  const found=await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({},direct)},{runYtDlp});
  expect(found).toBe(direct);expect(found.renditions[0].hasAudio).toBeNull();expect(runYtDlp).toHaveBeenCalledTimes(1);
});
test('stop or expiry during metadata discovery cannot release a late rendition',async()=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html',format:'mp4'}]});
  const extracted=attachMediaDescriptor({},direct),controller=new AbortController();
  await expect(discoverMediaSource({url:sourceUrl,extracted,signal:controller.signal},{runYtDlp:async()=>{
    controller.abort();return attachMediaDescriptor({},direct);
  }})).rejects.toMatchObject({code:'attempt_stopped'});
  const clock=jest.spyOn(Date,'now');let now=1000;clock.mockImplementation(()=>now);
  await expect(discoverMediaSource({url:sourceUrl,extracted,deadline:5000,config:{requestTimeoutMs:100}},{runYtDlp:async()=>{
    now=1101;return attachMediaDescriptor({},direct);
  }})).rejects.toMatchObject({code:'dependency_timeout'});
});
test.each([false,true])('caption-only HTML allows one video discovery, cached=%s',async cached=>{
  const unavailable=createMediaDescriptor({url:sourceUrl});
  const available=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/video.mp4',format:'mp4'}]});
  const fresh=attachMediaDescriptor({description:'A restaurant in Kyoto'},unavailable);
  const extracted=cached?JSON.parse(JSON.stringify(fresh)):fresh;
  const runYtDlp=jest.fn().mockResolvedValue(attachMediaDescriptor({mediaDiscoveryAttempted:true},available));
  expect(await discoverMediaSource({url:sourceUrl,extracted},{runYtDlp})).toBe(available);
  expect(runYtDlp).toHaveBeenCalledTimes(1);
  expect(runYtDlp.mock.calls[0][1]).toMatchObject({mediaOnly:true});
});
test.each([false,true])('a completed unsuccessful discovery is not retried, cached=%s',async cached=>{
  const fresh=attachMediaDescriptor({mediaDiscoveryAttempted:true},createMediaDescriptor({url:sourceUrl}));
  const extracted=cached?JSON.parse(JSON.stringify(fresh)):fresh,runYtDlp=jest.fn();
  expect((await discoverMediaSource({url:sourceUrl,extracted},{runYtDlp})).availability).toBe('unavailable');
  expect(runYtDlp).not.toHaveBeenCalled();
});
test.each([{isLive:true},{isCarousel:true}])('known unsupported media %p does not launch another reader',async flags=>{
  const descriptor=createMediaDescriptor({url:sourceUrl,...flags}),runYtDlp=jest.fn();
  expect(await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({},descriptor)},{runYtDlp})).toBe(descriptor);
  expect(runYtDlp).not.toHaveBeenCalled();
});
test('a block during caption-only discovery propagates without another request',async()=>{
  const blocked=Object.assign(new Error('source limited'),{code:'rate_limited'});
  const runYtDlp=jest.fn().mockRejectedValue(blocked);
  const extracted=attachMediaDescriptor({description:'Dinner'},createMediaDescriptor({url:sourceUrl}));
  await expect(discoverMediaSource({url:sourceUrl,extracted},{runYtDlp})).rejects.toBe(blocked);
  expect(runYtDlp).toHaveBeenCalledTimes(1);
});
test('JSON cache loses local URL but allows exactly one current-attempt rediscovery',async()=>{
  const descriptor=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/video.mp4',format:'mp4'}]});
  const extracted=JSON.parse(JSON.stringify(attachMediaDescriptor({mediaDiscoveryAttempted:true},descriptor)));
  const runYtDlp=jest.fn().mockResolvedValue(attachMediaDescriptor({},descriptor));
  await discoverMediaSource({url:sourceUrl,extracted},{runYtDlp});expect(runYtDlp).toHaveBeenCalledTimes(1);
});
test.each([{code:'rate_limited'},{code:'access_blocked'},{status:429}])('source failure %p authorizes no rediscovery',async sourceFailure=>{
  const runYtDlp=jest.fn();await expect(discoverMediaSource({url:sourceUrl,sourceFailure},{runYtDlp})).rejects.toBe(sourceFailure);
  expect(runYtDlp).not.toHaveBeenCalled();
});
test('streams to private file and pins validated answer into actual socket lookup',async()=>{
  const destination=path.join(root,'video');
  const request=transport([{chunks:[mp4.subarray(0,9),mp4.subarray(9)]}],(_url,options)=>{
    expect(options.headers.Authorization).toBeUndefined();
    options.agent.options.lookup('cdn.example',{},(err,address,family)=>{expect(err).toBeNull();expect(address).toBe('93.184.216.34');expect(family).toBe(4);});
  });
  const result=await downloadPublicMedia({url:'https://cdn.example/video',destination},{request});
  expect(result.bytes).toBe(mp4.length);expect(result.container).toBe('mp4');expect(result.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await fsp.stat(destination)).mode&0o777).toBe(0o600);expect(dns.lookup).toHaveBeenCalledTimes(1);
});
test.each(['https://127.0.0.1/private','http://cdn.example/video','https://user:pass@cdn.example/video','https://cdn.example:8443/video'])('redirect to %s cannot connect',async location=>{
  const request=transport([{status:302,headers:{location}}]);
  await expect(downloadPublicMedia({url:'https://cdn.example/video',destination:path.join(root,'video')},{request})).rejects.toMatchObject({code:'access_blocked'});
  expect(request).toHaveBeenCalledTimes(1);
});
test('mixed public/private DNS answers fail closed before socket creation',async()=>{
  dns.lookup.mockResolvedValue([{address:'93.184.216.34',family:4},{address:'10.1.2.3',family:4}]);
  const request=transport([]);
  await expect(downloadPublicMedia({url:'https://cdn.example/video',destination:path.join(root,'video')},{request})).rejects.toMatchObject({code:'access_blocked'});
  expect(request).not.toHaveBeenCalled();
});
test.each([{headers:{'content-length':'1000'},chunks:[mp4]},{chunks:[mp4,mp4]}])('size bounds reject before/while streaming and delete partial file',async response=>{
  const destination=path.join(root,'video');
  await expect(downloadPublicMedia({url:'https://cdn.example/v',destination,maxBytes:mp4.length},{request:transport([response])})).rejects.toMatchObject({code:'input_too_large'});
  await expect(fsp.stat(destination)).rejects.toMatchObject({code:'ENOENT'});
});
test('upstream failure waits for a delayed file open and close before cleanup',async()=>{
  const destination=path.join(root,'delayed-open'),realOpen=fs.open;
  let releaseOpen,settled=false;
  const opened=new Promise(resolve=>{
    jest.spyOn(fs,'open').mockImplementation((filename,flags,mode,callback)=>{
      realOpen(filename,flags,mode,(...args)=>{
        releaseOpen=()=>callback(...args);
        resolve();
      });
    });
  });
  const result=downloadPublicMedia({url:'https://cdn.example/v',destination,maxBytes:mp4.length},
    {request:transport([{chunks:[mp4,mp4]}])}).then(value=>{
      settled=true;return value;
    },failure=>{settled=true;return failure;});
  await opened;
  try {
    await new Promise(resolve=>setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {releaseOpen();}
  expect(await result).toMatchObject({code:'input_too_large'});
  await expect(fsp.stat(destination)).rejects.toMatchObject({code:'ENOENT'});
});
test('disguised manifest and empty/malformed containers cannot reach decoder',async()=>{
  const destination=path.join(root,'video');
  await expect(downloadPublicMedia({url:'https://cdn.example/video.mp4',destination},{request:transport([{chunks:[Buffer.from('#EXTM3U\nhttp://127.0.0.1/private')]}])})).rejects.toMatchObject({code:'invalid_response'});
  expect(sniffContainer(Buffer.from('not a video'))).toBeNull();
});
test('429 stops after one rendition and preserves cooldown hint',async()=>{
  const descriptor=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/1',format:'mp4'},{url:'https://cdn.example/2',format:'mp4'}]});
  const request=transport([{status:429,headers:{'retry-after':'60'}}]);
  await expect(acquireMedia({descriptor,root},{request})).rejects.toMatchObject({code:'rate_limited',retryAfterSeconds:60});
  expect(request).toHaveBeenCalledTimes(1);expect(await fsp.readdir(root)).toEqual([]);
});
test('caller disposal does not remove a pending operation input; last release does',async()=>{
  const workspace=await createWorkspace({root});await fsp.writeFile(path.join(workspace.directory,'input'),'bytes');
  const release=workspace.retain();await workspace.dispose();await workspace.dispose();
  expect(await fsp.readFile(path.join(workspace.directory,'input'),'utf8')).toBe('bytes');
  await release();await release();await expect(fsp.stat(workspace.directory)).rejects.toMatchObject({code:'ENOENT'});
});
test('orphan sweep preserves active/live/unrecognized directories and removes only aged dead owner',async()=>{
  const live=await createWorkspace({root});
  const dead=path.join(root,'mapd-media-DEAD');await fsp.mkdir(dead);await fsp.writeFile(path.join(dead,'owner.json'),JSON.stringify({version:1,pid:99999,createdAt:1}));
  expect(await sweepOrphanWorkspaces({root,olderThanMs:100,now:1000,identifyProcess:async()=>({state:'dead'})})).toBe(1);
  expect((await fsp.stat(live.directory)).isDirectory()).toBe(true);await live.dispose();
});
test('orphan sweep detects PID reuse by birth identity and conservatively retains unknown owners',async()=>{
  const cases=[['REUSED','linux:old:1',{state:'alive',birth:'linux:new:2'},true],
    ['LIVE','linux:same:1',{state:'alive',birth:'linux:same:1'},false],
    ['UNKNOWN','linux:old:1',{state:'unknown'},false],
    ['NOIDENTITY',null,{state:'alive',birth:'linux:new:2'},false],
    ['DEAD','linux:old:1',{state:'dead'},true]];
  for(let i=0;i<cases.length;i++) {
    const [name,birth]=cases[i],directory=path.join(root,`mapd-media-${name}`);await fsp.mkdir(directory);
    await fsp.writeFile(path.join(directory,'owner.json'),JSON.stringify({version:2,pid:10000+i,processBirth:birth,createdAt:1}));
  }
  expect(await sweepOrphanWorkspaces({root,olderThanMs:100,now:1000,identifyProcess:async pid=>cases[pid-10000][2]})).toBe(2);
  for(const [name,,,removed] of cases)expect((await fsp.readdir(root)).includes(`mapd-media-${name}`)).toBe(!removed);
});
test('workspace persists the process-instance identity when the OS exposes it',async()=>{
  const workspace=await createWorkspace({root});
  const marker=JSON.parse(await fsp.readFile(path.join(workspace.directory,'owner.json')));
  expect(marker).toMatchObject({version:2,pid:process.pid});
  const identity=await require('../lib/media/publicMediaDownload').processIdentity(process.pid);
  if(identity.state==='alive')expect(marker.processBirth).toBe(identity.birth);
  else expect(marker.processBirth).toBeNull();
  await workspace.dispose();
});
test('workspace quota catches secondary artifacts and symlinks',async()=>{
  const workspace=await createWorkspace({root,maxBytes:1024});await fsp.writeFile(path.join(workspace.directory,'large'),Buffer.alloc(2000));
  await expect(workspace.assertQuota()).rejects.toMatchObject({code:'input_too_large'});await workspace.dispose();
});
test('timed original-language cues are retained without manufacturing missing intervals',()=>{
  expect(parseSubtitleCues('WEBVTT\n\n00:00:02.000 --> 00:00:03.500\n太寿司\n\n00:00:08.000 --> 00:00:09.000\nNhâm Café','vtt')).toEqual([
    {startMs:2000,endMs:3500,text:'太寿司',timing:'native'},{startMs:8000,endMs:9000,text:'Nhâm Café',timing:'native'}]);
  expect(parseSubtitleCues('{"events":[{"tStartMs":1000,"dDurationMs":500,"segs":[{"utf8":"Tai Sushi"}]}]}','json3')[0]).toMatchObject({startMs:1000,endMs:1500});
});
test('download cancellation closes request, rejects once, and removes partial bytes',async()=>{
  const controller=new AbortController(),destination=path.join(root,'cancelled');
  let response;
  const request=jest.fn((_url,options,cb)=>{
    const req=new EventEmitter();req.end=()=>setImmediate(()=>{
      response=new Readable({read(){}});response.statusCode=200;response.headers={};cb(response);response.push(mp4);
      setImmediate(()=>controller.abort());
    });
    options.signal.addEventListener('abort',()=>{response?.destroy(options.signal.reason);req.emit('error',options.signal.reason);},{once:true});return req;
  });
  await expect(downloadPublicMedia({url:'https://cdn.example/v',destination,signal:controller.signal},{request})).rejects.toMatchObject({code:'attempt_stopped'});
  await expect(fsp.stat(destination)).rejects.toMatchObject({code:'ENOENT'});expect(request).toHaveBeenCalledTimes(1);
});
test('header stall hits total download deadline without retry',async()=>{
  const request=jest.fn((_url,options)=>{
    const req=new EventEmitter();req.end=()=>{};
    options.signal.addEventListener('abort',()=>req.emit('error',options.signal.reason),{once:true});return req;
  });
  await expect(downloadPublicMedia({url:'https://cdn.example/v',destination:path.join(root,'timeout'),deadline:Date.now()+20},{request})).rejects.toMatchObject({code:'dependency_timeout'});
  expect(request).toHaveBeenCalledTimes(1);
});
test('exclusive output collision cannot delete an existing file',async()=>{
  const destination=path.join(root,'exists');await fsp.writeFile(destination,'preserve existing data');
  await expect(downloadPublicMedia({url:'https://cdn.example/v',destination},{request:transport([{}])})).rejects.toMatchObject({code:'dependency_error'});
  expect(await fsp.readFile(destination,'utf8')).toBe('preserve existing data');
});
test('metadata for a different post cannot donate its video',()=>{
  expect(mediaFromYtDlp({webpage_url:'https://www.instagram.com/reel/OTHER/',url:'https://cdn.example/v',ext:'mp4'},sourceUrl).availability).toBe('unavailable');
});

function separateDescriptor(override={},metadata={}) {
  return mediaFromYtDlp({webpage_url:sourceUrl,duration:30,formats:[
    {url:'https://cdn.example/video.mp4',ext:'mp4',protocol:'https',vcodec:'vp9',acodec:'none',height:640,width:360},
    {url:'https://cdn.example/audio.m4a',ext:'m4a',protocol:'https',vcodec:'none',acodec:'mp4a.40.5',...override},
  ],...metadata},sourceUrl);
}
test('same-post yt-dlp direct AAC becomes one private audio-only candidate, never a video rendition',()=>{
  const descriptor=separateDescriptor();
  expect(descriptor.audioRendition).toEqual({url:'https://cdn.example/audio.m4a',format:'m4a',contentId:'instagram:SYNTHETIC'});
  expect(descriptor.renditions).toHaveLength(1);expect(descriptor.renditions[0].hasAudio).toBe(false);
  expect(JSON.stringify(descriptor)).not.toContain('audio.m4a');
  expect(JSON.stringify(attachMediaDescriptor({},descriptor))).not.toContain('cdn.example');
  expect(JSON.parse(JSON.stringify(descriptor)).audioRendition).toBeUndefined();
});
test.each([
  {vcodec:'h264'}, {vcodec:undefined}, {acodec:'none'}, {acodec:'opus'}, {protocol:'http_dash_segments'},
  {protocol:'http'}, {url:'http://cdn.example/audio'}, {url:'https://u:p@cdn.example/audio'},
  {url:'https://cdn.example/audio.m3u8'}, {fragments:[{}]}, {manifest_url:'https://cdn.example/a.mpd'},
  {has_drm:true}, {ext:'webm'}, {url:'https://cdn.example/video.mp4'},
])('unsupported separate audio cannot become download authority: %p',override=>{
  expect(separateDescriptor(override).audioRendition).toBeUndefined();
});
test.each([{webpage_url:undefined},{webpage_url:'https://www.instagram.com/reel/OTHER/'},{is_live:true},{entries:[{},{}]}])('audio requires exact same-post identity and supported content: %p',metadata=>{
  expect(separateDescriptor({},metadata).audioRendition).toBeUndefined();
});
test('separate audio shares one workspace, stays alive through owned references, and can acquire only once',async()=>{
  const request=transport([{},{}]);
  const video=await acquireMedia({descriptor:separateDescriptor(),root},{request});
  const audio=await acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request});
  expect(audio.directory).toBe(video.directory);expect(audio.path).not.toBe(video.path);
  expect((await fsp.stat(audio.path)).mode&0o777).toBe(0o600);
  expect(await fsp.readdir(root)).toHaveLength(1);expect(request).toHaveBeenCalledTimes(2);
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'attempt_stopped'});
  await video.dispose();expect((await fsp.stat(audio.path)).isFile()).toBe(true);
  await audio.dispose();await audio.dispose();await expect(fsp.stat(video.directory)).rejects.toMatchObject({code:'ENOENT'});
});
test('muxed or forged video cannot acquire separate audio',async()=>{
  const request=transport([{}]);const video=await acquireMedia({descriptor:separateDescriptor(),root},{request});
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:true}},{request})).rejects.toMatchObject({code:'attempt_stopped'});
  await expect(acquireSeparateAudio({media:{...video},processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'attempt_stopped'});
  expect(request).toHaveBeenCalledTimes(1);await video.dispose();
});
test('audio byte limit is the remaining cumulative video+audio allowance, not a fresh allowance',async()=>{
  const request=transport([{},{}]);const video=await acquireMedia({descriptor:separateDescriptor(),root,config:{maxDownloadBytes:mp4.length*2-1}},{request});
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'input_too_large'});
  await expect(fsp.stat(path.join(video.directory,'audio.media'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await fsp.readFile(video.path)).toEqual(mp4);expect(request).toHaveBeenCalledTimes(2);await video.dispose();
});
test('audio respects remaining single-workspace quota and leaves the video usable after failure',async()=>{
  const request=transport([{},{}]);const video=await acquireMedia({descriptor:separateDescriptor(),root,config:{maxWorkspaceBytes:1024}},{request});
  const used=await video.assertQuota();await fsp.writeFile(path.join(video.directory,'ballast'),Buffer.alloc(1024-used-8));
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'input_too_large'});
  expect(await video.assertQuota()).toBeLessThanOrEqual(1024);expect(await fsp.readFile(video.path)).toEqual(mp4);await video.dispose();
});
test('video probing/waiting consumes the same absolute 25s download window',async()=>{
  const request=transport([{}]);const now=Date.now();
  const video=await acquireMedia({descriptor:separateDescriptor(),root},{request});
  jest.spyOn(Date,'now').mockReturnValue(now+25001);
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'dependency_timeout'});
  expect(request).toHaveBeenCalledTimes(1);await video.dispose();
});
test.each([429,403])('separate audio HTTP %s consumes its only attempt and never damages video',async status=>{
  const request=transport([{}, {status,headers:{'retry-after':'60'}}]);
  const video=await acquireMedia({descriptor:separateDescriptor(),root},{request});
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:status===429?'rate_limited':'access_blocked'});
  await expect(acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})).rejects.toMatchObject({code:'attempt_stopped'});
  expect(request).toHaveBeenCalledTimes(2);expect(await fsp.readFile(video.path)).toEqual(mp4);await video.dispose();
});
test('parallel separate audio acquisition admits one request',async()=>{
  const request=transport([{},{}]);const video=await acquireMedia({descriptor:separateDescriptor(),root},{request});
  const results=await Promise.allSettled([1,2].map(()=>acquireSeparateAudio({media:video,processed:{hasAudio:false}},{request})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(request).toHaveBeenCalledTimes(2);
  await results.find(r=>r.status==='fulfilled').value.dispose();await video.dispose();
});

const {readMediaSourceDiagnostics,MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS}=require('../lib/media/mediaSource');
const diagnosticAudio=extra=>({url:'https://cdn.example/audio.m4a?private=signed-value',ext:'m4a',protocol:'https',vcodec:'none',acodec:'mp4a.40.5',...extra});
test('source diagnostics distinguish provided/bound audio using only fixed numeric counters',()=>{
  const descriptor=separateDescriptor(),stats=readMediaSourceDiagnostics(descriptor);
  expect(stats).toMatchObject({mediaSourceYtDlp:1,mediaSourceRootFormats:2,mediaSourceRootAudioFormats:1,
    mediaSourceRootEligibleAudio:1,mediaSourcePostBound:1,mediaSourceAudioEligible:1,mediaSourceAudioAttached:1,
    mediaSourceAudioRejectVideo:1,mediaSourceEntryFormats:0});
  expect(Object.entries(stats).every(([name,value])=>MEDIA_SOURCE_DIAGNOSTIC_OPERATIONS.includes(name) && Number.isSafeInteger(value) && value>=0 && value<=1000)).toBe(true);
  expect(JSON.stringify(stats)).not.toMatch(/SYNTHETIC|instagram:|https:|mp4a|signed-value/);
  expect(JSON.stringify(descriptor)).not.toContain('mediaSourceRootFormats');
  stats.mediaSourceRootFormats=999;expect(readMediaSourceDiagnostics(descriptor).mediaSourceRootFormats).toBe(2);
  expect(readMediaSourceDiagnostics({mediaSourceYtDlp:1,diagnostics:stats})).toEqual({mediaSourceUnknown:1});
});
test.each([
  ['Video',{vcodec:'vp9'}],['Codec',{acodec:'private-unknown-codec'}],['Container',{ext:'webm'}],
  ['Protocol',{protocol:'http_dash_segments'}],['Fragments',{fragments:[{}]}],
  ['Manifest',{manifest_url:'https://cdn.example/private.mpd'}],['Drm',{has_drm:true}],
  ['Url',{url:'http://cdn.example/private'}],['Duplicate',{url:'https://cdn.example/video.mp4'}],
])('source diagnostics count %s rejection without changing audio eligibility', (reason,override)=>{
  const descriptor=separateDescriptor(override),stats=readMediaSourceDiagnostics(descriptor);
  expect(stats[`mediaSourceAudioReject${reason}`]).toBeGreaterThanOrEqual(1);
  expect(stats.mediaSourceAudioEligible).toBe(0);expect(stats.mediaSourceAudioAttached).toBe(0);
  expect(descriptor.audioRendition).toBeUndefined();expect(JSON.stringify(stats)).not.toContain('private');
});
test.each([[undefined,'mediaSourcePostMissing'],['https://www.instagram.com/reel/OTHER/','mediaSourcePostMismatch']])('eligible bytes cannot bypass %s post binding', (webpage_url,metric)=>{
  const descriptor=separateDescriptor({}, {webpage_url}),stats=readMediaSourceDiagnostics(descriptor);
  expect(stats[metric]).toBe(1);expect(stats.mediaSourcePostBound).toBe(0);
  expect(stats.mediaSourceRootEligibleAudio).toBe(1);expect(stats.mediaSourceAudioEligible).toBe(0);
  expect(descriptor.audioRendition).toBeUndefined();
});
test('root stream and nested entry audio are observable but cannot donate a new unbound track',()=>{
  const descriptor=mediaFromYtDlp({...diagnosticAudio(),webpage_url:sourceUrl,
    entries:[{webpage_url:sourceUrl,formats:[diagnosticAudio()]}]},sourceUrl);
  expect(readMediaSourceDiagnostics(descriptor)).toMatchObject({mediaSourceTopAudioOnly:1,mediaSourceTopAudioEligible:1,
    mediaSourceRootFormats:0,mediaSourceEntries:1,mediaSourceEntryFormats:1,mediaSourceEntryAudioFormats:1,
    mediaSourceEntryEligibleAudio:1,mediaSourceAudioEligible:0,mediaSourceAudioAttached:0});
  expect(descriptor.availability).toBe('unavailable');expect(descriptor.audioRendition).toBeUndefined();
});
test('metadata inspection has fixed scan bounds and signals truncation',()=>{
  const descriptor=mediaFromYtDlp({webpage_url:sourceUrl,formats:Array(101).fill(diagnosticAudio()),
    entries:Array(11).fill({formats:Array(101).fill(diagnosticAudio())})},sourceUrl);
  const stats=readMediaSourceDiagnostics(descriptor);
  expect(stats).toMatchObject({mediaSourceRootFormats:100,mediaSourceEntries:10,mediaSourceEntryFormats:1000,
    mediaSourceRootAudioFormats:100,mediaSourceEntryEligibleAudio:1000,mediaSourceScanTruncated:1,
    mediaSourceAudioEligible:0,mediaSourceAudioAttached:0});
});
test('unavailable source diagnostics survive reused discovery and one on-demand discovery',async()=>{
  const descriptor=mediaFromYtDlp({webpage_url:sourceUrl,entries:[{formats:[diagnosticAudio()]}]},sourceUrl);
  const extracted=attachMediaDescriptor({mediaDiscoveryAttempted:true},descriptor),runYtDlp=jest.fn(async()=>extracted);
  expect(await discoverMediaSource({url:sourceUrl,extracted},{runYtDlp})).toBe(descriptor);
  expect(runYtDlp).not.toHaveBeenCalled();
  const fresh=await discoverMediaSource({url:sourceUrl},{runYtDlp,withProvider:(_p,work)=>work()});
  expect(runYtDlp).toHaveBeenCalledTimes(1);
  expect(readMediaSourceDiagnostics(fresh).mediaSourceEntryEligibleAudio).toBe(1);
  expect(fresh.availability).toBe('unavailable');
});
test('HTML fallback preserves failed discovery diagnostics without exporting or granting entry audio',async()=>{
  const direct=createMediaDescriptor({url:sourceUrl,renditions:[{url:'https://cdn.example/html.mp4',format:'mp4'}]});
  const unavailable=mediaFromYtDlp({webpage_url:sourceUrl,entries:[{formats:[diagnosticAudio()]}]},sourceUrl);
  const result=await discoverMediaSource({url:sourceUrl,extracted:attachMediaDescriptor({},direct)},
    {runYtDlp:async()=>attachMediaDescriptor({},unavailable),withProvider:(_p,work)=>work()});
  expect(result).toBe(direct);expect(result.audioRendition).toBeUndefined();
  expect(readMediaSourceDiagnostics(result)).toMatchObject({mediaSourceDirect:1,mediaSourceYtDlp:1,
    mediaSourceFallback:1,mediaSourceEntryEligibleAudio:1,mediaSourceAudioAttached:0});
});
