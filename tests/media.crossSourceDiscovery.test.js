'use strict';
// Synthetic, offline regression cases. Unknown HTML audio is only a reason
// to choose a candidate for probing, never proof of an audible track.
const {parseInstagramPost}=require('../lib/postMetadata');
const {createMediaDescriptor,attachMediaDescriptor,mediaFromYtDlp,discoverMediaSource,
  readMediaSourceDiagnostics}=require('../lib/media/mediaSource');
const {EngineError}=require('../lib/engineError');
const url='https://www.instagram.com/reel/SYNTHETIC/';
const htmlVideo='https://cdn.example/same-post-html.mp4';
const ytVideo='https://cdn.example/same-post-yt.mp4';
function htmlPost(extra={}) {
  const parsed=parseInstagramPost('<script>'+JSON.stringify({items:[
    {shortcode:'OTHER',video_url:'https://cdn.example/unrelated.mp4',has_audio:true},
    {shortcode:'SYNTHETIC',caption:{text:'Synthetic caption'},video_url:htmlVideo,...extra},
  ]})+'</script>','SYNTHETIC');
  expect(parsed.tagMetadataAvailable).toBe(true);
  expect(parsed.mediaRenditions.some(r=>r.url.includes('unrelated'))).toBe(false);
  return attachMediaDescriptor({description:parsed.caption},createMediaDescriptor({url,renditions:parsed.mediaRenditions}));
}
function ytPost(extra={},postUrl=url) {
  return attachMediaDescriptor({mediaDiscoveryAttempted:true},mediaFromYtDlp({webpage_url:postUrl,
    formats:[{url:ytVideo,ext:'mp4',protocol:'https',width:360,height:640,vcodec:'vp9',acodec:'none',...extra}]},postUrl));
}
function reader(data) {
  return {runYtDlp:jest.fn(async()=>data),withProvider:jest.fn(async(_provider,work)=>work())};
}

test('successful silent discovery retains distinct same-post HTML with possible audio before download',async()=>{
  const extracted=htmlPost(),discovered=ytPost(),deps=reader(discovered);
  const selected=await discoverMediaSource({url,extracted},deps);
  expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
  expect(deps.runYtDlp.mock.calls[0][1]).toMatchObject({mediaOnly:true});
  expect(selected.renditions[0]).toMatchObject({url:htmlVideo,hasAudio:null});
  expect(selected.audioRendition).toBeUndefined();
  expect(discovered.mediaDescriptor.renditions[0]).toMatchObject({url:ytVideo,hasAudio:false});
  expect(readMediaSourceDiagnostics(selected)).toMatchObject({mediaSourceCombined:1,mediaSourcePostBound:1,
    mediaSourceUniqueAudioAbsent:1,mediaSourceUniqueAudioUnknown:1,mediaSourceChosenAudioState:2});
  const serialized=JSON.stringify(attachMediaDescriptor({},selected));
  expect(serialized).not.toContain('cdn.example');expect(serialized).not.toContain('renditions');
});

test('same URL explicitly silent in yt-dlp is not revived by HTML unknown metadata',async()=>{
  const extracted=htmlPost(),discovered=ytPost({url:htmlVideo});
  const selected=await discoverMediaSource({url,extracted},reader(discovered));
  expect(selected).toBe(discovered.mediaDescriptor);
  expect(selected.renditions).toHaveLength(1);expect(selected.renditions[0].hasAudio).toBe(false);
  expect(extracted.mediaDescriptor.renditions[0].hasAudio).toBeNull();
});

test('silence outside the yt-dlp shortlist still disqualifies the matching HTML candidate',async()=>{
  const extracted=htmlPost();
  const formats=[640,960,1280,1920].map(height=>({url:`https://cdn.example/silent-${height}.mp4`,
    ext:'mp4',protocol:'https',vcodec:'vp9',acodec:'none',width:360,height}));
  formats.push({url:htmlVideo,ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none'});
  const descriptor=mediaFromYtDlp({webpage_url:url,formats},url);
  const selected=await discoverMediaSource({url,extracted},reader(attachMediaDescriptor({},descriptor)));
  expect(selected).toBe(descriptor);expect(selected.renditions).toHaveLength(4);
  expect(selected.renditions.every(r=>r.hasAudio===false)).toBe(true);
  expect(readMediaSourceDiagnostics(selected).mediaSourceUniqueAudioAbsent).toBe(5);
});

test('full HTML inventory supplies the fifth possible audio candidate after four duplicate demotions',async()=>{
  const videos=Array.from({length:5},(_,i)=>({url:`https://cdn.example/html-${i}.mp4`,format:'mp4',height:640}));
  const direct=createMediaDescriptor({url,renditions:videos});
  const descriptor=mediaFromYtDlp({webpage_url:url,formats:videos.slice(0,4).map(v=>({
    url:v.url,ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none',height:640}))},url);
  const selected=await discoverMediaSource({url,extracted:attachMediaDescriptor({},direct)},reader(attachMediaDescriptor({},descriptor)));
  expect(selected.renditions[0]).toMatchObject({url:videos[4].url,hasAudio:null});
  expect(readMediaSourceDiagnostics(selected)).toMatchObject({mediaSourceDuplicateAudioDemotions:4,
    mediaSourceUniqueAudioAbsent:4,mediaSourceUniqueAudioUnknown:1});
  expect(direct.renditions.every(r=>r.hasAudio===null)).toBe(true);
});

test('an evidenced muxed discovery already supersedes unknown HTML',async()=>{
  const discovered=ytPost({acodec:'aac'}),deps=reader(discovered);
  expect(await discoverMediaSource({url,extracted:htmlPost()},deps)).toBe(discovered.mediaDescriptor);
  expect(discovered.mediaDescriptor.renditions[0].hasAudio).toBe(true);
  expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
});

test('current cache boundary: serialization discards even a known-audio HTML descriptor',async()=>{
  const extracted=htmlPost({video_url:undefined,video_versions:[{url:htmlVideo,has_audio:true}]}),deps=reader(ytPost());
  expect(extracted.mediaDescriptor.renditions[0].hasAudio).toBe(true);
  expect(await discoverMediaSource({url,extracted},deps)).toBe(extracted.mediaDescriptor);
  expect(deps.runYtDlp).not.toHaveBeenCalled();
  const cached=JSON.parse(JSON.stringify(extracted));
  expect(cached.mediaAvailable).toBe(true);expect(cached.mediaDescriptor).toBeUndefined();
  expect(JSON.stringify(cached)).not.toContain('cdn.example');
  const selected=await discoverMediaSource({url,extracted:cached},deps);
  expect(selected.renditions[0]).toMatchObject({url:ytVideo,hasAudio:false});
  expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
});

test.each(['rate_limited','access_blocked','dependency_timeout','attempt_stopped'])(
  '%s discovery failure still terminates; an HTML alternative grants no retry or fallback',async code=>{
    const error=new EngineError(code,{stage:'source'}),deps=reader(null);
    deps.runYtDlp.mockRejectedValue(error);
    await expect(discoverMediaSource({url,extracted:htmlPost()},deps)).rejects.toBe(error);
    expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
  });

test('another-post discovery cannot replace or combine with held HTML',async()=>{
  const deps=reader(ytPost({acodec:'aac'},'https://www.instagram.com/reel/OTHER/'));
  await expect(discoverMediaSource({url,extracted:htmlPost()},deps)).rejects.toMatchObject({code:'source_unavailable'});
  expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
});

test.each([{isLive:true},{isCarousel:true}])('terminal exclusion %p remains stronger than held HTML',async exclusion=>{
  const descriptor=createMediaDescriptor({url,...exclusion}),deps=reader(attachMediaDescriptor({},descriptor));
  expect(await discoverMediaSource({url,extracted:htmlPost()},deps)).toBe(descriptor);
  expect(descriptor.availability).toBe('unavailable');expect(descriptor.renditions).toEqual([]);
});

test('same-post music metadata is not assumed to be the exact post audio timeline',()=>{
  const extracted=htmlPost({clips_metadata:{music_info:{music_asset_info:{progressive_download_url:'https://cdn.example/music-only.m4a'}}}});
  expect(extracted.mediaDescriptor.audioRendition).toBeUndefined();
  expect(extracted.mediaDescriptor.renditions[0]).toMatchObject({url:htmlVideo,hasAudio:null});
  expect(JSON.stringify(extracted)).not.toContain('music-only');
});


test('explicitly bound separate audio remains preferable to an unknown HTML video',async()=>{
  const descriptor=mediaFromYtDlp({webpage_url:url,formats:[
    {url:ytVideo,ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none'},
    {url:'https://cdn.example/audio.m4a',ext:'m4a',protocol:'https',vcodec:'none',acodec:'aac'},
  ]},url);
  expect(await discoverMediaSource({url,extracted:htmlPost()},reader(attachMediaDescriptor({},descriptor)))).toBe(descriptor);
  expect(descriptor.audioRendition).toBeDefined();
});

test.each([undefined,'https://www.instagram.com/reel/OTHER/'])(
  'unbound yt-dlp metadata %s grants no cross-reader combination',async webpage_url=>{
    const descriptor=mediaFromYtDlp({webpage_url,formats:[
      {url:ytVideo,ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none'},
    ]},url);
    const selected=await discoverMediaSource({url,extracted:htmlPost()},reader(attachMediaDescriptor({},descriptor)));
    expect(readMediaSourceDiagnostics(selected).mediaSourceCombined).toBeUndefined();
    if(webpage_url===undefined)expect(selected).toBe(descriptor);
    else expect(selected.renditions[0].url).toBe(htmlVideo); // Existing empty-success fallback only.
  });

test('unknown yt-dlp audio keeps its existing selection without another reader',async()=>{
  const discovered=ytPost({acodec:undefined}),deps=reader(discovered);
  expect(await discoverMediaSource({url,extracted:htmlPost()},deps)).toBe(discovered.mediaDescriptor);
  expect(deps.runYtDlp).toHaveBeenCalledTimes(1);
});

test('each private inventory is bounded to 100 inputs; no unbounded recursive merge or serialized authority',async()=>{
  const videos=Array.from({length:105},(_,i)=>({url:`https://cdn.example/html-${i}.mp4`,format:'mp4'}));
  const direct=createMediaDescriptor({url,renditions:videos});
  const formats=videos.map((_,i)=>({url:`https://cdn.example/yt-${i}.mp4`,ext:'mp4',protocol:'https',vcodec:'h264',acodec:'none'}));
  const descriptor=mediaFromYtDlp({webpage_url:url,formats},url);
  const selected=await discoverMediaSource({url,extracted:attachMediaDescriptor({},direct)},reader(attachMediaDescriptor({},descriptor)));
  expect(selected.renditions).toHaveLength(4);
  // The top metadata object is one of yt-dlp's 100 scanned video inputs.
  expect(readMediaSourceDiagnostics(selected)).toMatchObject({mediaSourceUniqueAudioUnknown:100,mediaSourceUniqueAudioAbsent:99});
  const recursive=await discoverMediaSource({url,extracted:attachMediaDescriptor({},selected)},reader(attachMediaDescriptor({},descriptor)));
  expect(recursive).toBe(descriptor);
  const forged={mediaDescriptor:JSON.parse(JSON.stringify(selected))};
  expect(await discoverMediaSource({url,extracted:forged},reader(attachMediaDescriptor({},descriptor)))).toBe(descriptor);
});
