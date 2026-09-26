const mockCache=new Map();
jest.mock('../lib/cache',()=>({getCached:jest.fn(async k=>mockCache.get(k)),setCache:jest.fn(async(k,v)=>mockCache.set(k,v))}));
jest.mock('../lib/providerRuntime',()=>({withProvider:jest.fn(async(_provider,run)=>run({deadline:Date.now()+10000}))}));
jest.mock('axios',()=>({post:jest.fn()}));
const axios=require('axios');
const {searchGooglePlaces}=require('../enrich/places');
let originalKey;
beforeAll(()=>{originalKey=process.env.GOOGLE_PLACES_API_KEY;process.env.GOOGLE_PLACES_API_KEY='test-only';});
afterAll(()=>{if(originalKey===undefined)delete process.env.GOOGLE_PLACES_API_KEY;else process.env.GOOGLE_PLACES_API_KEY=originalKey;});
beforeEach(()=>{mockCache.clear();jest.clearAllMocks();});

test('language is sent to Google and caches stay separate from old default-language entries',async()=>{
  mockCache.set('places:search:query',[{place_id:'one',name:'Shang Hao'}]);
  axios.post.mockResolvedValue({data:{places:[{id:'one',displayName:{text:'上好雞肉'},formattedAddress:'台灣新北市',location:{latitude:25,longitude:121},addressComponents:[{longText:'台灣',shortText:'TW',types:['country']}]}]}});
  expect((await searchGooglePlaces('Query'))[0].name).toBe('Shang Hao');
  const localized=await searchGooglePlaces('Query',undefined,undefined,{languageCode:'zh-TW'});
  expect(localized[0]).toMatchObject({name:'上好雞肉',address_components:[{long_name:'台灣',short_name:'TW',types:['country']}]});
  expect(axios.post.mock.calls[0][1]).toEqual({textQuery:'Query',pageSize:5,languageCode:'zh-TW'});
  expect(axios.post.mock.calls[0][2].headers['X-Goog-FieldMask']).toContain('places.addressComponents');
  await searchGooglePlaces('Query',undefined,undefined,{languageCode:'zh-TW'});
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect((await searchGooglePlaces('Query'))[0].name).toBe('Shang Hao');
});

test('request failures do not become cached empty search results',async()=>{
  axios.post.mockRejectedValue({response:{status:429}});
  await expect(searchGooglePlaces('Query',undefined,undefined,{languageCode:'ja'})).rejects.toMatchObject({code:'rate_limited'});
  expect(mockCache.size).toBe(0);
});
