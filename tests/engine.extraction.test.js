jest.mock('../lib/urlResolve',()=>({isShortSocialUrl:u=>u.includes('instagr.am'),resolveOneRedirect:jest.fn()}));
jest.mock('../lib/cache',()=>({getCached:jest.fn(),setCache:jest.fn(),normalizeUrlForCache:u=>u.replace(/\?stkn=.*/, '')}));
jest.mock('../lib/instagramReel',()=>({isInstagramReelUrl:()=>true,fetchInstagramReelPost:jest.fn()}));
jest.mock('../lib/instagramCarousel',()=>({isInstagramPostUrl:()=>false}));
jest.mock('../lib/tiktokPhoto',()=>({isTikTokPhotoUrl:()=>false}));
jest.mock('../lib/ytdlp',()=>({runYtDlp:jest.fn()}));
jest.mock('../lib/providerRuntime',()=>({withLease:(_k,w)=>w(),withProvider:(_p,w)=>w()}));
const {fetchInstagramReelPost}=require('../lib/instagramReel');
const {runYtDlp}=require('../lib/ytdlp');
const {getCached,setCache}=require('../lib/cache');
const {extractPublicPost}=require('../lib/extraction');
const url='https://www.instagram.com/reel/SYNTHETIC/';
beforeEach(()=>{jest.clearAllMocks();getCached.mockResolvedValue(null);});
test('concurrent shares of the same post perform only one extraction',async()=>{
  let finish;fetchInstagramReelPost.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const first=extractPublicPost(url),second=extractPublicPost(url+'?stkn=123');
  await new Promise(setImmediate);finish({description:'Dinner @ab',webpage_url:url});
  await Promise.all([first,second]);expect(fetchInstagramReelPost).toHaveBeenCalledTimes(1);
});
test('a 429 does not trigger another reader or cache a failure',async()=>{
  fetchInstagramReelPost.mockRejectedValue(Object.assign(new Error('rate limited'),{status:429}));
  await expect(extractPublicPost(url)).rejects.toMatchObject({code:'rate_limited'});
  expect(runYtDlp).not.toHaveBeenCalled();expect(setCache).not.toHaveBeenCalled();
});
test('format drift can fall back within the active attempt',async()=>{
  fetchInstagramReelPost.mockRejectedValue(new Error('No OG metadata'));
  runYtDlp.mockResolvedValue({description:'Dinner @ab',webpage_url:url});
  await expect(extractPublicPost(url)).resolves.toHaveProperty('description','Dinner @ab');
  expect(runYtDlp).toHaveBeenCalledTimes(1);
});

test('simultaneous short links share resolution and extraction',async()=>{
  const {resolveOneRedirect}=require('../lib/urlResolve');
  resolveOneRedirect.mockResolvedValue(url);
  fetchInstagramReelPost.mockResolvedValue({description:'Dinner @ab',webpage_url:url});
  await Promise.all([extractPublicPost('https://instagr.am/test/'),extractPublicPost('https://instagr.am/test/')]);
  expect(resolveOneRedirect).toHaveBeenCalledTimes(1);expect(fetchInstagramReelPost).toHaveBeenCalledTimes(1);
});
