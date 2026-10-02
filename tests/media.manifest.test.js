const {manifestKey,readManifest,writeManifest}=require('../lib/media/mediaEvidenceCache');
const {DEFAULT_MEDIA_CONFIG}=require('../lib/media/mediaConfig');
const base={url:'https://www.instagram.com/reel/abc/',ogData:{title:'Caption'},config:DEFAULT_MEDIA_CONFIG,userId:'u'};
const result={attempted:true,incomplete:false,mediaDigest:'a'.repeat(64),places:[{name:'Cafe',requiresSelection:true,evidenceRefs:[{evidenceId:'a:1',quote:'Cafe',supports:'name'}]}],coverage:{audio:{status:'complete'},visual:{status:'complete'},fusion:{status:'complete'}},retryOperations:[]};
test('manifest identity changes with private user/notes, caption, model and policy',()=>{
 const publicKey=manifestKey(base);expect(manifestKey({...base,userId:'v'})).toBe(publicKey);
 const privateInput={...base,ogData:{shareText:'My note',description:'My note'}};
 expect(manifestKey(privateInput)).not.toBe(manifestKey({...privateInput,userId:'v'}));
 expect(manifestKey({...base,config:{...DEFAULT_MEDIA_CONFIG,scanFps:3}})).not.toBe(publicKey);
 expect(manifestKey({...base,ogData:{title:'Changed'}})).not.toBe(publicKey);
});
test('only completed valid evidence is stored; no automatic failed-result refresh',async()=>{
 const writer=jest.fn();await writeManifest('key',result,{writer,now:()=>100});expect(writer).toHaveBeenCalledTimes(1);
 await writeManifest('key',{...result,incomplete:true},{writer});expect(writer).toHaveBeenCalledTimes(1);
});
test('old silent-rendition manifests cannot suppress new audio discovery',async()=>{
 const key=manifestKey(base),oldKey=key.replace('media-manifest-v5:','media-manifest-v4:');
 expect(oldKey).not.toBe(key);
 const old={...result,coverage:{...result.coverage,audio:{status:'unavailable',reason:'no_audio_track'}}};
 const cache=new Map([[oldKey,{version:1,createdAt:100,result:old}]]);
 const reader=async k=>cache.get(k),writer=async(k,value)=>cache.set(k,value);
 expect(await readManifest(key,{reader,now:()=>1000})).toBeNull();
 await writeManifest(key,result,{writer,now:()=>1000});
 expect(await readManifest(key,{reader,now:()=>1001})).toEqual(result);
 expect(cache.get(oldKey).result).toEqual(old);
});
test('freshness is bounded explicitly, future/expired/invalid manifests miss',async()=>{
 const item={version:1,createdAt:100,result};
 expect(await readManifest('key',{reader:async()=>item,now:()=>1000})).toEqual(result);
 expect(await readManifest('key',{reader:async()=>item,now:()=>3600100})).toBeNull();
 expect(await readManifest('key',{reader:async()=>item,now:()=>50})).toBeNull();
 expect(await readManifest('key',{reader:async()=>({...item,result:{...result,places:[{name:'fabricated'}]}}),now:()=>1000})).toBeNull();
});

test('exact transcription context partitions manifests while absent context keeps legacy reuse',()=>{
 const {buildTranscriptionContext}=require('../lib/media/transcriptionContext');
 const before=manifestKey(base);
 expect(manifestKey({...base,transcriptionContext:null})).toBe(before);
 const one=buildTranscriptionContext({title:'Café São Bento'});
 const two=buildTranscriptionContext({title:'Café São Pedro'});
 expect(manifestKey({...base,transcriptionContext:one})).not.toBe(before);
 expect(manifestKey({...base,transcriptionContext:one})).not.toBe(manifestKey({...base,transcriptionContext:two}));
 expect(manifestKey({...base,transcriptionContext:one,userId:'another'})).toBe(manifestKey({...base,transcriptionContext:one}));
 expect(()=>manifestKey({...base,transcriptionContext:{...one,prompt:'override'}})).toThrow();
});

test('audio-only manifests cannot hide visual work when full media mode is enabled',async()=>{
 const {validateMediaConfig}=require('../lib/media/mediaConfig');
 const audioKey=manifestKey({...base,config:validateMediaConfig({policyVersion:'media-v2',analysisMode:'audio-only'})});
 const fullKey=manifestKey(base);expect(audioKey).not.toBe(fullKey);
 const audioResult={...result,coverage:{...result.coverage,visual:{status:'unavailable',reason:'disabled_by_policy',intervals:[]}}};
 const cache=new Map(),writer=async(k,v)=>cache.set(k,v),reader=async k=>cache.get(k);
 await writeManifest(audioKey,audioResult,{writer,now:()=>100});
 expect(await readManifest(audioKey,{reader,now:()=>200})).toEqual(audioResult);
 expect(await readManifest(fullKey,{reader,now:()=>200})).toBeNull();
});
