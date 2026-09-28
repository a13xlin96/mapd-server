'use strict';
const {mediaFromYtDlp,readMediaSourceDiagnostics,attachMediaDescriptor,createMediaDescriptor}=require('../lib/media/mediaSource');
const post='https://www.instagram.com/reel/BOUNDED/';
const video=(name,width,height,acodec='none')=>({url:`https://cdn.example/${name}`,ext:'mp4',protocol:'https',vcodec:'h264',acodec,width,height});
const aac={url:'https://cdn.example/audio',ext:'m4a',protocol:'https',vcodec:'none',acodec:'aac'};
const unknown={...video('unknown'),acodec:undefined};
function select(extra={}) {return mediaFromYtDlp({webpage_url:post,duration:62,formats:[unknown,video('large',1080,1920),video('bounded',720,1280),video('preview',360,640),aac],...extra},post);}
const chosen=d=>d.renditions[0].url.split('/').at(-1);

test.each([62,undefined,null,0,Infinity])('separate AAC never displaces possible muxed audio, duration %p',duration=>{
 const d=select({duration});expect(chosen(d)).toBe('unknown');expect(d.renditions).toHaveLength(4);
 expect(d.audioRendition.url).toBe(aac.url);
 expect(readMediaSourceDiagnostics(d)).toMatchObject({mediaSourceChosenAudioState:2,mediaSourceAudioAttached:1});
 if(duration!==62)expect(d.durationMs).toBeNull();
 expect(JSON.stringify(attachMediaDescriptor({description:'Public caption'},d))).not.toContain('cdn.example');
});
test('proven muxed audio retains precedence over unknown or silent alternatives',()=>{
 const d=select({formats:[unknown,video('muxed',1080,1920,'aac'),video('bounded',720,1280),aac]});
 expect(chosen(d)).toBe('muxed');expect(d.renditions[0].hasAudio).toBe(true);
});
test('without a possible muxed source, existing separate-track support remains available',()=>{
 const d=select({formats:[video('bounded',720,1280),aac]});
 expect(chosen(d)).toBe('bounded');expect(d.renditions[0].hasAudio).toBe(false);
 expect(d.audioRendition.url).toBe(aac.url);
});
test('audio duplicate outside the shortlist cannot authorize a separate track',()=>{
 const formats=[...Array.from({length:5},(_,i)=>({...unknown,url:`https://cdn.example/u${i}`})),video('bounded',720,1280),{...aac,url:'https://cdn.example/bounded'}];
 const d=select({formats});expect(chosen(d)).toBe('u0');expect(d.audioRendition).toBeUndefined();
 expect(readMediaSourceDiagnostics(d).mediaSourceAudioRejectDuplicate).toBe(1);
});
test.each([false,true])('explicit silence beats duplicated muxed claims, reverse order %p',reverse=>{
 const copies=[video('bounded',720,1280,'aac'),video('bounded',720,1280)];
 if(reverse)copies.reverse();
 const d=select({formats:[unknown,...copies,aac]});expect(chosen(d)).toBe('unknown');
 expect(d.renditions.find(r=>r.url.endsWith('/bounded')).hasAudio).toBe(false);
 expect(readMediaSourceDiagnostics(d).mediaSourceDuplicateAudioDemotions).toBe(1);
});
test.each([
 {webpage_url:undefined},
 {formats:[unknown,video('bounded',720,1280)]},
 {formats:[unknown,video('bounded',720,1280),{...aac,protocol:'http_dash_segments'}]},
 {formats:[unknown,video('bounded',720,1280),{...aac,fragments:[{}]}]},
 {formats:[unknown,video('bounded',720,1280),{...aac,has_drm:true}]},
])('invalid or missing separate audio preserves selection and cannot attach a track: %p',extra=>{
 const d=select(extra);expect(chosen(d)).toBe('unknown');expect(d.audioRendition).toBeUndefined();
});
test.each([[360,640],[480,854],[640,360],[100,2000],[1080,1920]])('possible muxed source %px%p keeps precedence over smaller silent video',(width,height)=>{
 const d=select({formats:[{...unknown,url:'https://cdn.example/original',width,height},video('bounded',720,1280),aac]});
 expect(chosen(d)).toBe('original');expect(d.renditions[0].hasAudio).toBeNull();
});
test('wrong-post, live and carousel metadata cannot donate video or audio',()=>{
 for(const flags of [{webpage_url:'https://www.instagram.com/reel/OTHER/'},{is_live:true},{entries:[{},{}]}]) {
  const d=select(flags);expect(d.availability).toBe('unavailable');expect(d.audioRendition).toBeUndefined();
 }
});
test('HTML-only descriptors retain established audio precedence',()=>{
 const d=createMediaDescriptor({url:post,renditions:[{url:unknown.url,format:'mp4'},
  {url:'https://cdn.example/bounded',format:'mp4',hasAudio:false,width:720,height:1280}]});
 expect(chosen(d)).toBe('unknown');
});
