jest.mock('../lib/anthropic',()=>({anthropic:{messages:{create:jest.fn()}}}));
jest.mock('../lib/cache',()=>({getCached:jest.fn(),setCache:jest.fn()}));
jest.mock('../lib/firestore',()=>({firestore:null}));
jest.mock('../lib/thumbnails',()=>({downloadImage:jest.fn()}));
jest.mock('../lib/providerRuntime',()=>({withProvider:jest.fn(async (_p,work)=>{
  await require('../lib/jobContext').current()?.sharedOperation?.authorizeDispatch();return work();
})}));
const {anthropic}=require('../lib/anthropic');
const {downloadImage}=require('../lib/thumbnails');
const {getCached,setCache}=require('../lib/cache');
const {extractPlacesFromSlides}=require('../lib/vision');
const {SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const response=value=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}]});
const base={imageUrls:['https://cdn.example/1'],caption:'Coffee in Kyoto'};
const options={scope:SERVER_PUBLIC_SCOPE};
beforeEach(()=>{
  jest.clearAllMocks();getCached.mockResolvedValue(null);
  downloadImage.mockImplementation(async url=>({bytes:Buffer.from(url.endsWith('2')?'second':'first'),contentType:'image/jpeg'}));
  anthropic.messages.create.mockResolvedValue(response({places:[{name:'Cafe',location:'Kyoto'}]}));
});
test('signed URL changes with identical bytes share one provider operation',async()=>{
  const [one,two]=await Promise.all([
    extractPlacesFromSlides({...base,imageUrls:['https://cdn.example/first?sig=a']},options),
    extractPlacesFromSlides({...base,imageUrls:['https://cdn.example/first?sig=b']},options),
  ]);
  expect(one).toEqual(two);expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(downloadImage).toHaveBeenCalledTimes(2);
});
test('changed image bytes and changed slide order generate different identities',async()=>{
  await extractPlacesFromSlides({...base,imageUrls:['https://cdn.example/1','https://cdn.example/2']},options);
  const key1=setCache.mock.calls[0][0];
  await extractPlacesFromSlides({...base,imageUrls:['https://cdn.example/2','https://cdn.example/1']},options);
  const key2=setCache.mock.calls[1][0];
  downloadImage.mockResolvedValue({bytes:Buffer.from('replacement'),contentType:'image/jpeg'});
  await extractPlacesFromSlides({...base,imageUrls:['https://cdn.example/1','https://cdn.example/2']},options);
  const key3=setCache.mock.calls[2][0];
  expect(new Set([key1,key2,key3]).size).toBe(3);
  for(const call of setCache.mock.calls) {
    expect(JSON.stringify(call)).not.toContain('https://');expect(JSON.stringify(call)).not.toContain(Buffer.from('replacement').toString('base64'));
  }
});
test('different private UIDs and changed text do not coalesce',async()=>{
  await Promise.all([
    extractPlacesFromSlides(base,{scope:'user:a'}),
    extractPlacesFromSlides(base,{scope:'user:b'}),
    extractPlacesFromSlides({...base,caption:'Tokyo'}, {scope:'user:a'}),
  ]);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
});
test('no downloaded images is a source failure and creates no AI call',async()=>{
  downloadImage.mockRejectedValue(new Error('download failed'));
  await expect(extractPlacesFromSlides(base,options)).rejects.toMatchObject({code:'source_unavailable'});
  expect(anthropic.messages.create).not.toHaveBeenCalled();expect(setCache).not.toHaveBeenCalled();
});
test.each([{bad:[]},{places:[{name:123}]},{places:[{name:''}]},{places:Array.from({length:41},()=>({name:'Cafe'}))}])('malformed model output stays failure: %j',async result=>{
  anthropic.messages.create.mockResolvedValue(response(result));
  await expect(extractPlacesFromSlides(base,options)).rejects.toMatchObject({code:'invalid_response'});
  expect(setCache).not.toHaveBeenCalled();
});
test('partial image download with no found place is not a successful empty result',async()=>{
  downloadImage.mockRejectedValueOnce(new Error('download failed'));
  anthropic.messages.create.mockResolvedValue(response({places:[]}));
  await expect(extractPlacesFromSlides({...base,imageUrls:['1','2']},options)).rejects.toMatchObject({code:'source_unavailable'});
  expect(setCache).not.toHaveBeenCalled();
});
test('valid full coverage empty remains short-lived and refresh ignores completed cache',async()=>{
  anthropic.messages.create.mockResolvedValue(response({places:[]}));
  const empty=await extractPlacesFromSlides(base,options);
  expect(empty.places).toEqual([]);expect(setCache.mock.calls[0][2]).toBe(300);
  getCached.mockResolvedValue(empty);getCached.mockClear();
  await extractPlacesFromSlides(base,{...options,bypassCache:true});
  expect(getCached).not.toHaveBeenCalled();expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
});
test('abort during image downloads prevents provider dispatch',async()=>{
  const controller=new AbortController();
  downloadImage.mockImplementation(async()=>{controller.abort();return {bytes:Buffer.from('image'),contentType:'image/png'};});
  await expect(extractPlacesFromSlides(base,{...options,signal:controller.signal})).rejects.toMatchObject({code:'attempt_stopped'});
  expect(anthropic.messages.create).not.toHaveBeenCalled();
});

test('vision requests provide bounded text, image and output observation descriptors',async()=>{
  const {withProvider}=require('../lib/providerRuntime');
  await extractPlacesFromSlides({...base,imageUrls:['1','2']},options);
  const observation=withProvider.mock.calls[0][3];
  expect(observation).toMatchObject({stage:'vision',rateKey:'haiku',descriptor:{model:require('../lib/engineVersion').model,maxImageTokens:400000,maxOutputTokens:2400,cacheEnabled:false}});
  expect(observation.descriptor.maxInputTokens).toBeGreaterThan(1024);
  expect(JSON.stringify(observation)).not.toContain('Coffee');
});
