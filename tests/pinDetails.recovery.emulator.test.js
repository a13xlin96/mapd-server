// Opt-in correctness tests: loopback Firestore only; no real providers or Redis.
jest.mock('../lib/firestore', () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (host && !/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Loopback emulator required');
  process.env.METADATA_SERVER_DETECTION = 'none';
  const admin = require('firebase-admin');
  return {admin, firestore: host ? new admin.firestore.Firestore({
    projectId: `demo-details-fixes-${process.pid}`, host, ssl: false,
  }) : null};
});
jest.mock('../lib/cache', () => ({redis:null,getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})}));
jest.mock('axios', () => ({get:jest.fn(),post:jest.fn(()=>{throw new Error('Unexpected provider post');})}));
jest.mock('../lib/push', () => ({sendPushForJob:jest.fn()}));
jest.mock('../lib/anthropic', () => ({anthropic:{messages:{create:jest.fn(()=>{throw new Error('Unexpected AI call');})}}}));
jest.mock('../lib/thumbnails', () => ({persistThumbnail:jest.fn(async()=> '')}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation:jest.fn(()=>({
  id:'test-observation',markDispatched:jest.fn(async()=>{}),settle:jest.fn(async()=>{}),releaseUnsent:jest.fn(async()=>{}),
}))}));

const {randomUUID}=require('crypto');
const {firestore:db,admin}=require('../lib/firestore');
const {enqueueNewPin,createPinDetails,generation}=require('../lib/pinDetails');
const {getPlaceDetails,getCachedPlaceDetails}=require('../enrich/places');
const {withLease}=require('../lib/providerRuntime');
const axios=require('axios');
const cache=require('../lib/cache');
const suite=process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function until(predicate) {
  const end=Date.now()+8000;
  while(!await predicate()) {
    if(Date.now()>=end)throw new Error('Fixture barrier timed out');
    await new Promise(r=>setTimeout(r,10));
  }
}

suite('deferred details recovery correctness on real Firestore',()=>{
  let uid,id,placeId,pinRef,taskRef,service,key,entries;
  const response=()=>({data:{id:placeId,displayName:{text:'Provider Restaurant'},
    location:{latitude:35,longitude:135},types:['restaurant'],primaryType:'restaurant',rating:4.5,dineIn:true}});
  const value=patch=>({userId:uid,placeId,placeName:'Saved Cafe',category:'cafe',city:'Kyoto',country:'Japan',
    latitude:35,longitude:135,types:['cafe'],rating:null,
    detailsSchemaVersion:1,detailsState:'pending',detailsRevision:1,...patch});
  async function seed(patch={},ref=pinRef) {
    const pin=value(patch);
    await db.runTransaction(async tx=>{tx.set(ref,pin);enqueueNewPin(tx,db,admin,ref,pin);});
  }
  beforeAll(()=>{key=process.env.GOOGLE_PLACES_API_KEY;process.env.GOOGLE_PLACES_API_KEY='synthetic-details-key';});
  beforeEach(async()=>{
    uid=`owner-${randomUUID()}`;id=`pin-${uid}`;placeId=`place-${uid}`;
    pinRef=db.collection('pins').doc(id);taskRef=db.collection('pinDetailTasks').doc(id);
    await db.collection('users').doc(uid).set({});
    entries=new Map();jest.clearAllMocks();axios.get.mockImplementation(async()=>response());
    cache.getCached.mockImplementation(async key=>entries.get(key)||null);
    cache.setCache.mockImplementation(async(key,value)=>{entries.set(key,value);});
    service=createPinDetails({db,admin,fetchDetails:getPlaceDetails});
  });
  afterAll(async()=>{
    if(key===undefined)delete process.env.GOOGLE_PLACES_API_KEY;else process.env.GOOGLE_PLACES_API_KEY=key;
    await db.terminate();
  });

  test('correction cancels obsolete pending state, then owner explicit retry replaces it idempotently',async()=>{
    await seed();const initial=await pinRef.get(),taskId=(await taskRef.get()).data().taskId;
    await pinRef.update({placeId:`corrected-${uid}`,placeName:'Correct Cafe'});
    expect(await service.process(id)).toBe('skipped');
    expect((await pinRef.get()).data()).toMatchObject({detailsState:'needs_action',detailsRevision:1,detailsTaskId:taskId});
    expect((await taskRef.get()).data()).toMatchObject({status:'cancelled',pinGeneration:generation(initial)});
    expect(axios.get).not.toHaveBeenCalled();
    await expect(service.retry(id,`${uid}-other`,1,taskId)).rejects.toMatchObject({code:'access_blocked'});
    const replies=await Promise.all(Array.from({length:4},()=>service.retry(id,uid,1,taskId)));
    expect(replies).toEqual(Array(4).fill({status:'queued',revision:2}));
    expect(await service.process(id)).toBe('complete');
    expect(axios.get).toHaveBeenCalledTimes(1);expect(axios.get.mock.calls[0][0]).toContain(`corrected-${uid}`);
    expect((await pinRef.get()).data()).toMatchObject({placeName:'Correct Cafe',detailsState:'complete',detailsRevision:2,rating:4.5});
    expect(await service.retry(id,uid,1,taskId)).toEqual({status:'complete',revision:2});
  },20000);

  test('explicit correction replaces running task; old result cannot overwrite new revision',async()=>{
    await seed();const held=deferred();axios.get.mockImplementationOnce(()=>held.promise);
    const old=service.process(id);await until(()=>axios.get.mock.calls.length===1);
    const taskId=(await taskRef.get()).data().taskId;
    await pinRef.update({placeId:`corrected-${uid}`,placeName:'Correct Cafe',detailsState:'needs_action'});
    await service.retry(id,uid,1,taskId);
    expect(await service.process(id)).toBe('complete');
    held.resolve({data:{...response().data,rating:1}});expect(await old).toBe('stale');
    expect((await pinRef.get()).data()).toMatchObject({placeName:'Correct Cafe',rating:4.5,detailsRevision:2,detailsState:'complete'});
    expect(axios.get).toHaveBeenCalledTimes(2);
  },20000);

  test.each(['pin deletion','account deletion','place correction','pin replacement'])(
    '%s during occupied Google capacity revokes sole subscriber before physical send',async change=>{
      await seed();const release=deferred();let held=0;
      const holders=Array.from({length:4},()=>withLease('provider:google',async()=>{held++;await release.promise;},{slots:4}));
      await until(()=>held===4);const running=service.process(id);
      try {
        await until(async()=>{
          const task=(await taskRef.get()).data();
          const operations=await db.collection('engineSharedAiOperations').where('state','==','running').get();
          return task?.dispatched===true && operations.docs.some(doc=>!doc.data().dispatch);
        });
        expect(axios.get).not.toHaveBeenCalled();
        if(change==='pin deletion')await pinRef.delete();
        if(change==='account deletion')await db.collection('users').doc(uid).delete();
        if(change==='place correction')await pinRef.update({placeId:`corrected-${uid}`});
        if(change==='pin replacement'){
          await pinRef.delete();await pinRef.set(value({placeName:'Replacement without task'}));
        }
      }finally{release.resolve();await Promise.all(holders);}
      expect(await running).toBe('cancelled');expect(axios.get).not.toHaveBeenCalled();
      expect((await taskRef.get()).data().status).toBe('cancelled');
      if(change==='place correction')expect((await pinRef.get()).data().detailsState).toBe('needs_action');
      if(change==='pin deletion')expect((await pinRef.get()).exists).toBe(false);
      if(change==='pin replacement')expect((await pinRef.get()).data()).toEqual(value({placeName:'Replacement without task'}));
    },20000);

  test('invalidated initiating pin leaves another valid shared subscriber able to fetch',async()=>{
    await seed();const second=db.collection('pins').doc(`${id}-second`);await seed({},second);
    const release=deferred();let held=0;
    const holders=Array.from({length:4},()=>withLease('provider:google',async()=>{held++;await release.promise;},{slots:4}));
    await until(()=>held===4);const first=service.process(id),other=service.process(second.id);
    try{
      await until(async()=>{
        const tasks=await Promise.all([taskRef.get(),db.collection('pinDetailTasks').doc(second.id).get()]);
        return tasks.every(t=>t.data().dispatched);
      });
      await pinRef.delete();
    }finally{release.resolve();await Promise.all(holders);}
    expect(await first).toBe('cancelled');expect(await other).toBe('complete');
    expect(axios.get).toHaveBeenCalledTimes(1);expect((await second.get()).data().rating).toBe(4.5);
  },20000);

  test.each([false,true])('invalid provider result never caches or completes retry (legacy cache=%s)',async legacy=>{
    await seed();
    if(legacy)entries.set(`places:details:v3:${placeId}`,{name:'Invalid old cache',geometry:{location:{lat:null,lng:null}}});
    axios.get.mockResolvedValueOnce({data:{id:placeId,displayName:{text:'Incomplete'},types:['cafe']}});
    expect(await service.process(id)).toBe('needs_action');const failed=(await taskRef.get()).data();
    expect(failed.failure.code).toBe('invalid_response');
    expect(cache.setCache.mock.calls.filter(([key])=>key===`places:details:v3:${placeId}`)).toHaveLength(0);
    await expect(getCachedPlaceDetails(placeId)).resolves.toBeNull();
    expect(await service.process(id)).toBe('skipped');expect(axios.get).toHaveBeenCalledTimes(1);
    await service.retry(id,uid,1,failed.taskId);expect(await service.process(id)).toBe('complete');
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect((await pinRef.get()).data()).toMatchObject({detailsState:'complete',detailsRevision:2,rating:4.5});
  },20000);

  test('valid cache satisfies owner retry and failed or dismissed shares are never reset',async()=>{
    await seed();const jobs=['failed','dismissed'].map(status=>db.collection('enrichmentJobs').doc(`${id}-${status}`));
    await Promise.all(jobs.map((ref,i)=>ref.set({userId:uid,status:i ? 'dismissed':'failed',pinId:id})));
    axios.get.mockRejectedValueOnce(new Error('offline'));
    expect(await service.process(id)).toBe('needs_action');const taskId=(await taskRef.get()).data().taskId;
    entries.set(`places:details:v3:${placeId}`,{name:'Cached valid',geometry:{location:{lat:35,lng:135}},types:['cafe'],rating:4.9});
    await service.retry(id,uid,1,taskId);expect(await service.process(id)).toBe('complete');
    expect(axios.get).toHaveBeenCalledTimes(1);expect((await taskRef.get()).data().dispatched).toBe(false);
    expect((await pinRef.get()).data().rating).toBe(4.9);
    expect((await Promise.all(jobs.map(ref=>ref.get()))).map(snap=>snap.data().status)).toEqual(['failed','dismissed']);
  },20000);

  test.each(['before claim','during fetch','before retry'])(
    'old client same-value edit %s protects category and permits optional attributes',async when=>{
      await seed();const edit=()=>pinRef.update({category:'cafe',updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      if(when==='before claim')await edit();
      if(when==='before retry'){
        axios.get.mockRejectedValueOnce(new Error('offline'));await service.process(id);
        await edit();await service.retry(id,uid,1,(await taskRef.get()).data().taskId);
      }
      if(when==='during fetch')axios.get.mockImplementationOnce(async()=>{await edit();return response();});
      expect(await service.process(id)).toBe('complete');
      expect((await pinRef.get()).data()).toMatchObject({category:'cafe',rating:4.5,dineIn:true,detailsState:'complete'});
    },20000);

  test('server failure/retry preserves accepted category while filling optional metadata',async()=>{
    await seed();axios.get.mockRejectedValueOnce(new Error('offline'));await service.process(id);
    await service.retry(id,uid,1,(await taskRef.get()).data().taskId);expect(await service.process(id)).toBe('complete');
    expect((await pinRef.get()).data()).toMatchObject({category:'cafe',rating:4.5});
    expect((await taskRef.get()).data().protectMutableFields).toBe(false);
  },20000);

  test('deleted pin is not resurrected and recreation cannot reuse a cancelled task generation',async()=>{
    await seed();const taskId=(await taskRef.get()).data().taskId,original=generation(await pinRef.get());
    await pinRef.delete();await service.process(id);
    expect((await pinRef.get()).exists).toBe(false);
    expect((await taskRef.get()).data().pinGeneration).toBe(original);
    await pinRef.set(value({detailsTaskId:taskId,placeId:`replacement-${uid}`}));
    await expect(service.retry(id,uid,1,taskId)).rejects.toMatchObject({code:'access_blocked'});
    expect(axios.get).not.toHaveBeenCalled();
  },20000);

  test('correcting away and back after completed details does not strand recovery',async()=>{
    await seed();
    expect(await service.process(id)).toBe('complete');
    const taskId=(await taskRef.get()).data().taskId;
    // Both writes mirror confirmed corrections in PinDetailSheet; neither
    // correction requested an optional-details retry yet.
    await pinRef.update({placeId:`corrected-${uid}`,placeName:'Temporary B',detailsState:'needs_action'});
    await pinRef.update({placeId,placeName:'Back to A',detailsState:'needs_action'});
    const result=await service.retry(id,uid,1,taskId);
    if(result.status==='queued')await service.process(id);
    expect((await pinRef.get()).data().detailsState).toBe('complete');
  },20000);

  test('corrected place cannot inherit previous place optional business metadata',async()=>{
    await seed({types:['japanese_restaurant'],primaryType:'japanese_restaurant'});
    axios.get.mockResolvedValueOnce({data:{...response().data,types:['japanese_restaurant'],primaryType:'japanese_restaurant',
      websiteUri:'https://previous-place.example/',nationalPhoneNumber:'555-0101',
      regularOpeningHours:{weekdayDescriptions:['Monday: 9-5']},servesBeer:true}});
    expect(await service.process(id)).toBe('complete');
    const taskId=(await taskRef.get()).data().taskId;
    await pinRef.update({placeId:`corrected-${uid}`,placeName:'New Museum',category:'culture',detailsState:'needs_action'});
    axios.get.mockResolvedValueOnce({data:{id:`corrected-${uid}`,displayName:{text:'New Museum'},location:{latitude:35,longitude:135},types:['museum'],primaryType:'museum'}});
    await service.retry(id,uid,1,taskId);
    expect(await service.process(id)).toBe('complete');
    const final=(await pinRef.get()).data();
    expect(final.types).toEqual(['museum']);
    expect(final.website ?? null).toBeNull();
    expect(final.phoneNumber ?? null).toBeNull();
    expect(final.weekdayDescriptions ?? null).toBeNull();
    expect(final.servesBeer ?? null).toBeNull();
  },20000);

  test('correction while pending does not carry old search types into the new place',async()=>{
    await seed({types:['japanese_restaurant'],primaryType:'japanese_restaurant'});
    const taskId=(await taskRef.get()).data().taskId;
    await pinRef.update({placeId:`corrected-${uid}`,placeName:'New Museum',category:'attraction',detailsState:'needs_action'});
    axios.get.mockResolvedValueOnce({data:{id:`corrected-${uid}`,displayName:{text:'New Museum'},location:{latitude:35,longitude:135},types:['museum'],primaryType:'museum'}});
    await service.retry(id,uid,1,taskId);
    expect(await service.process(id)).toBe('complete');
    expect(axios.get).toHaveBeenCalledTimes(1);
    const final=(await pinRef.get()).data();
    expect(final.types).toEqual(['museum']);
    expect(final.cuisine ?? null).toBeNull();
  },20000);
});
