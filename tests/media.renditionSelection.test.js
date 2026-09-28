'use strict';
const {mediaFromYtDlp,readMediaSourceDiagnostics,attachMediaDescriptor,createMediaDescriptor}=require('../lib/media/mediaSource');
const post='https://www.instagram.com/reel/BOUNDED/';
const video=(name,width,height,acodec='none')=>({url:`https://cdn.example/${name}`,ext:'mp4',protocol:'https',vcodec:'h264',acodec,width,height});
const aac={url:'https://cdn.example/audio',ext:'m4a',protocol:'https',vcodec:'none',acodec:'aac'};
const unknown=video('unknown',undefined,undefined,undefined);
// Passing undefined to a default argument would turn it into known silence.
unknown.acodec=undefined;
function select(extra={}) {return mediaFromYtDlp({webpage_url:post,duration:62,formats:[unknown,video('large',1080,1920),video('bounded',720,1280),video('preview',360,640),aac],...extra},post);}
const chosen=d=>d.renditions[0].url.split('/').at(-1);
test('same-post AAC allows a known-size 720p rendition instead of unknown-size media',()=>{
 const d=select();expect(chosen(d)).toBe('bounded');expect(d.renditions).toHaveLength(4);
 expect(d.audioRendition.url).toBe(aac.url);
 expect(readMediaSourceDiagnostics(d)).toMatchObject({mediaSourceChosenWidth:720,mediaSourceChosenHeight:1280,mediaSourceChosenAudioState:1,mediaSourceAudioAttached:1});
 const publicData=attachMediaDescriptor({description:'Public caption'},d);
 expect(JSON.stringify(publicData)).not.toContain('cdn.example');
});
test('selection sees the full bounded inventory, including candidates beyond the old shortlist',()=>{
 const formats=[...Array.from({length:5},(_,i)=>({...unknown,url:`https://cdn.example/unknown${i}`})),video('bounded',720,1280),aac];
 expect(chosen(select({formats}))).toBe('bounded');
});
test('known muxed audio and existing bounded unknown-audio picks retain priority',()=>{
 expect(chosen(select({formats:[video('muxed',1080,1920,'aac'),video('bounded',720,1280),aac]}))).toBe('muxed');
 expect(chosen(select({formats:[video('existing',720,720,null),video('bounded',720,1280),aac]}))).toBe('existing');
});
test.each([
 {webpage_url:undefined},{duration:undefined},{duration:0},{duration:Infinity},
 {formats:[unknown,video('bounded',720,1280)]},
 {formats:[unknown,video('bounded',720,1280),{...aac,protocol:'http_dash_segments'}]},
 {formats:[unknown,video('bounded',720,1280),{...aac,fragments:[{}]}]},
 {formats:[unknown,video('bounded',720,1280),{...aac,has_drm:true}]},
])('insufficient audio/duration authority does not change unknown-audio precedence: %p',extra=>{
 expect(chosen(select(extra))).toBe('unknown');
});
test.each([[360,640],[480,854],[NaN,1280],[Infinity,1280],[720.5,1280],[720,undefined],[1080,1920]])('small, unknown or oversized rendition %p x %p cannot replace the old pick',(w,h)=>{
 expect(chosen(select({formats:[unknown,video('candidate',w,h),aac]}))).toBe('unknown');
});
test('chooses greatest bounded pixel area without reducing landscape or portrait to preview size',()=>{
 expect(chosen(select({formats:[unknown,video('square',720,720),video('landscape',1280,720),video('preview',360,640),aac]}))).toBe('landscape');
});
test('duplicate audio URL outside old shortlist is not authority to change video selection',()=>{
 const formats=[...Array.from({length:5},(_,i)=>({...unknown,url:`https://cdn.example/u${i}`})),video('bounded',720,1280),{...aac,url:'https://cdn.example/bounded'}];
 const d=select({formats});expect(chosen(d)).toBe('u0');expect(d.audioRendition).toBeUndefined();
 expect(readMediaSourceDiagnostics(d).mediaSourceAudioRejectDuplicate).toBe(1);
});
test('audio absence from a duplicate still wins when bounded video is selected',()=>{
 const duplicate={...video('bounded',720,1280,'aac')};
 const d=select({formats:[unknown,duplicate,video('bounded',720,1280),aac]});
 expect(chosen(d)).toBe('bounded');expect(d.renditions[0].hasAudio).toBe(false);
 expect(readMediaSourceDiagnostics(d).mediaSourceDuplicateAudioDemotions).toBe(1);
});
test('wrong-post, live and carousel media never become available through this selection',()=>{
 for(const flags of [{webpage_url:'https://www.instagram.com/reel/OTHER/'},{is_live:true},{entries:[{},{}]}]) {
  const d=select(flags);expect(d.availability).toBe('unavailable');expect(d.audioRendition).toBeUndefined();
 }
});
test('HTML-only descriptors retain the established audio-first policy',()=>{
 const d=createMediaDescriptor({url:post,durationMs:62000,renditions:[{url:unknown.url,format:'mp4'},
   {url:'https://cdn.example/bounded',format:'mp4',hasAudio:false,width:720,height:1280}]});
 expect(chosen(d)).toBe('unknown');
});

test.each([[360,640],[480,854],[640,360],[100,2000]])('known inexpensive %px%p source is never replaced by a higher-pixel silent rendition',(width,height)=>{
 const small={...unknown,url:'https://cdn.example/small',width,height};
 const d=select({formats:[small,video('bounded',720,1280),aac]});
 expect(chosen(d)).toBe('small');expect(d.renditions[0].hasAudio).toBeNull();
});
