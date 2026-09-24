jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
const mockCache=new Map();
jest.mock('../lib/cache',()=>({redis:null,getCached:jest.fn(async k=>mockCache.get(k)),setCache:jest.fn(async(k,v)=>mockCache.set(k,v))}));
jest.mock('axios',()=>({get:jest.fn(),post:jest.fn()}));
jest.mock('../lib/engineBudget',()=>({beginProviderObservation:jest.fn(()=>({id:'observation',markDispatched:jest.fn(async()=>{}),settle:jest.fn(async()=>{}),releaseUnsent:jest.fn(async()=>{})}))}));
const axios=require('axios');
const {firestore:db}=require('../lib/firestore');
const {getPlaceDetails,getCachedPlaceDetails}=require('../enrich/places');
const context=require('../lib/jobContext');
const {beginProviderObservation}=require('../lib/engineBudget');
const googleResult={data:{id:'place',displayName:{text:'Cafe'},location:{latitude:1,longitude:2},rating:4.5,types:['cafe']}};
let key;
beforeAll(()=>{key=process.env.GOOGLE_PLACES_API_KEY;process.env.GOOGLE_PLACES_API_KEY='synthetic-test-key';});
afterAll(()=>{if(key===undefined)delete process.env.GOOGLE_PLACES_API_KEY;else process.env.GOOGLE_PLACES_API_KEY=key;});
beforeEach(()=>{db.reset();mockCache.clear();jest.clearAllMocks();axios.get.mockResolvedValue(googleResult);});

test('simultaneous saved pins in different accounts share one physical details call, with each task authorized',async()=>{
  const authorizers=[jest.fn(async()=>{}),jest.fn(async()=>{}),jest.fn(async()=>{})];
  const results=await Promise.all(authorizers.map((beforeProviderDispatch,i)=>context.run({userId:`u${i}`,beforeProviderDispatch,deadline:Date.now()+10000},
    ()=>getPlaceDetails('place',{strict:true}))));
  expect(results).toHaveLength(3);expect(results.every(r=>r.name==='Cafe')).toBe(true);
  expect(axios.get).toHaveBeenCalledTimes(1);expect(beginProviderObservation).toHaveBeenCalledTimes(1);
  for(const authorize of authorizers)expect(authorize).toHaveBeenCalledTimes(1);
  await getPlaceDetails('place',{strict:true});
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('provider failure is not an empty success and requires explicit refresh to spend again',async()=>{
  axios.get.mockRejectedValueOnce(new Error('connection failed'));
  await expect(getPlaceDetails('place',{strict:true})).rejects.toBeDefined();
  await expect(getPlaceDetails('place',{strict:true})).rejects.toBeDefined();
  expect(axios.get).toHaveBeenCalledTimes(1);
  await expect(getPlaceDetails('place',{strict:true,refresh:true})).resolves.toMatchObject({name:'Cafe'});
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('task deleted before joining cannot dispatch, while an unrelated authorized save still can',async()=>{
  const {EngineError}=require('../lib/engineError');
  await expect(context.run({beforeProviderDispatch:async()=>{throw new EngineError('attempt_stopped');}},
    ()=>getPlaceDetails('place',{strict:true}))).rejects.toMatchObject({code:'attempt_stopped'});
  expect(axios.get).not.toHaveBeenCalled();
  await expect(getPlaceDetails('place',{strict:true})).resolves.toMatchObject({name:'Cafe'});
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test.each([
  {name:'Incomplete',geometry:{location:{lat:null,lng:2}}},
  {name:'Out of range',geometry:{location:{lat:91,lng:2}}},
  {name:'',geometry:{location:{lat:1,lng:2}}},
  {name:'Broken types',geometry:{location:{lat:1,lng:2}},types:{}},
])('invalid legacy cached payload is rejected by every reader: %p',async invalid=>{
  mockCache.set('places:details:v3:place',invalid);
  await expect(getCachedPlaceDetails('place')).resolves.toBeNull();
  await expect(getPlaceDetails('place',{strict:true})).resolves.toMatchObject({name:'Cafe'});
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(mockCache.get('places:details:v3:place').geometry.location).toEqual({lat:1,lng:2});
});

test('malformed successful response never populates legacy cache or falsely completes retry',async()=>{
  axios.get.mockResolvedValueOnce({data:{id:'place',displayName:{text:'Incomplete Cafe'},types:['cafe']}});
  await expect(getPlaceDetails('place',{strict:true})).rejects.toMatchObject({code:'invalid_response'});
  expect(mockCache.has('places:details:v3:place')).toBe(false);
  await expect(getPlaceDetails('place',{strict:true})).rejects.toMatchObject({code:'invalid_response'});
  expect(axios.get).toHaveBeenCalledTimes(1);
  await expect(getPlaceDetails('place',{strict:true,refresh:true})).resolves.toMatchObject({name:'Cafe'});
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('valid legacy cache satisfies explicit retry without another paid request',async()=>{
  const cached={name:'Valid cached cafe',geometry:{location:{lat:1,lng:2}},types:['cafe'],rating:4.9};
  mockCache.set('places:details:v3:place',cached);
  const authorize=jest.fn();
  await expect(context.run({beforeProviderDispatch:authorize},()=>getPlaceDetails('place',{strict:true,refresh:true}))).resolves.toEqual(cached);
  expect(authorize).not.toHaveBeenCalled();expect(axios.get).not.toHaveBeenCalled();
});
