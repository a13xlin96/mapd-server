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
test('freshness is bounded explicitly, future/expired/invalid manifests miss',async()=>{
 const item={version:1,createdAt:100,result};
 expect(await readManifest('key',{reader:async()=>item,now:()=>1000})).toEqual(result);
 expect(await readManifest('key',{reader:async()=>item,now:()=>3600100})).toBeNull();
 expect(await readManifest('key',{reader:async()=>item,now:()=>50})).toBeNull();
 expect(await readManifest('key',{reader:async()=>({...item,result:{...result,places:[{name:'fabricated'}]}}),now:()=>1000})).toBeNull();
});
