jest.mock('dns',()=>({promises:{lookup:jest.fn()}}));
jest.mock('../lib/providerRuntime',()=>({withProvider:(_p,work)=>work()}));
const {lookup}=require('dns').promises;
const {fetchPublic,publicAddress}=require('../lib/publicFetch');
const {fetchSourceHtml}=require('../lib/sourceFetch');
const {isAllowedExtractUrl}=require('../lib/urlValidation');
let axios;
beforeEach(()=>{
  jest.clearAllMocks();
  lookup.mockResolvedValue([{address:'93.184.215.14',family:4}]);
  axios={get:jest.fn(async()=>({status:200,headers:{},data:'page'})),head:jest.fn(async()=>({status:200,headers:{}}))};
});
test.each(['127.0.0.1','10.0.0.1','169.254.169.254','[::1]','[::ffff:127.0.0.1]','[64:ff9b::7f00:1]','[2002:7f00:1::]'])('private or translated address %s cannot be fetched',async host=>{
  await expect(publicAddress('https://'+host+'/')).rejects.toMatchObject({code:'access_blocked'});
  expect(lookup).not.toHaveBeenCalled();
});
test('mixed private/public DNS answers are rejected',async()=>{
  lookup.mockResolvedValue([{address:'93.184.215.14',family:4},{address:'192.168.1.1',family:4}]);
  await expect(fetchPublic('https://example.com',axios)).rejects.toMatchObject({code:'access_blocked'});
  expect(axios.get).not.toHaveBeenCalled();
});
test('the validated address is pinned into the HTTPS connection',async()=>{
  axios.get.mockImplementation(async(_url,options)=>{
    const cb=jest.fn();options.httpsAgent.options.lookup('example.com',{},cb);
    expect(cb).toHaveBeenCalledWith(null,'93.184.215.14',4);
    expect(options).toMatchObject({proxy:false,maxRedirects:0,maxContentLength:2097152});
    return {status:200,data:'page',headers:{}};
  });
  await fetchPublic('https://example.com',axios);expect(lookup).toHaveBeenCalledTimes(1);
});
test('HEAD resolution stays HEAD across relative redirects',async()=>{
  axios.head.mockResolvedValueOnce({status:302,headers:{location:'/final'}});
  expect((await fetchPublic('https://example.com/start',axios,{method:'HEAD'})).url).toBe('https://example.com/final');
  expect(axios.head).toHaveBeenCalledTimes(2);expect(axios.get).not.toHaveBeenCalled();
});
test('redirect to private address is blocked before the second request',async()=>{
  axios.get.mockResolvedValueOnce({status:302,headers:{location:'https://127.0.0.1/internal'}});
  await expect(fetchPublic('https://example.com',axios)).rejects.toMatchObject({code:'access_blocked'});
  expect(axios.get).toHaveBeenCalledTimes(1);
});
test('redirect loops have a fixed request budget',async()=>{
  axios.get.mockResolvedValue({status:302,headers:{location:'/again'}});
  await expect(fetchPublic('https://example.com',axios)).rejects.toMatchObject({code:'access_blocked'});
  expect(axios.get).toHaveBeenCalledTimes(4);
});
test('social 429 preserves its status and retry-after without downloading the body',async()=>{
  const cancel=jest.fn(),request=jest.fn(async()=>({status:429,ok:false,headers:{get:()=> '120'},body:{cancel}}));
  await expect(fetchSourceHtml('https://www.tiktok.com/@u/photo/123',{},request)).rejects.toMatchObject({status:429,retryAfter:'120'});
  expect(cancel).toHaveBeenCalled();expect(request).toHaveBeenCalledTimes(1);
});
test.each(['https://www.google.com/url?q=https://evil.com','https://www.youtube.com/redirect?q=https://evil.com','https://www.instagram.com:444/reel/TEST/','https://u:p@instagram.com/reel/TEST/'])('extractor cannot use redirector or authority %s',url=>{
  expect(isAllowedExtractUrl(url)).toBe(false);
});
