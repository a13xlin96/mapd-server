jest.mock('../lib/firestore',()=>{const {getSharedFirestore,makeAdmin}=require('./helpers/fakeFirestore');return {firestore:getSharedFirestore(),admin:makeAdmin()};});
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn()}));
const {firestore:db,admin}=require('../lib/firestore');
const {createPinDetails,enqueueNewPin}=require('../lib/pinDetails');
const context=require('../lib/jobContext');
const pin=()=>({userId:'u',placeId:'place',placeName:'Cafe',latitude:35,longitude:135,formattedAddress:'Kyoto, Japan',
  category:'other',city:null,country:null,url:'https://example.com',notes:'keep',listIds:['list'],
  detailsSchemaVersion:1,detailsState:'pending',detailsRevision:1});
const details=()=>({name:'Cafe',formatted_address:'Kyoto, Japan',geometry:{location:{lat:35,lng:135}},
  types:['cafe'],primary_type:'cafe',rating:4.5,serves_coffee:true,
  address_components:[{long_name:'Kyoto',types:['locality']},{long_name:'Japan',types:['country']}],
});
let time,service,fetch;
const taskId=()=>db.read('pinDetailTasks','pin').taskId;
async function seed(id='pin',value=pin()){
  const ref=db.collection('pins').doc(id);
  await db.runTransaction(async txn=>{txn.set(ref,value);enqueueNewPin(txn,db,admin,ref,value);});
}
beforeEach(()=>{
  time=100000;db.reset();db.setNow(()=>time);db.strictReadOrder=true;db.seed('users','u',{});
  fetch=jest.fn(async()=>{await context.current().beforeProviderDispatch();return details();});
  service=createPinDetails({db,admin,fetchDetails:fetch,now:()=>time});
});
afterEach(()=>{db.strictReadOrder=false;db.setNow(()=>Date.now());});

test('a durable task completes metadata without changing save fields or sources',async()=>{
  await seed();time+=1;
  expect(await service.process('pin')).toBe('complete');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(db.read('pins','pin')).toMatchObject({detailsState:'complete',detailsRevision:1,rating:4.5,servesCoffee:true,
    city:'Kyoto',country:'Japan',notes:'keep',listIds:['list'],url:'https://example.com'});
  expect(await service.process('pin')).toBe('skipped');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('optional provider failure leaves pin saved and requires an explicit idempotent retry',async()=>{
  await seed();fetch.mockRejectedValueOnce(new Error('network'));
  expect(await service.process('pin')).toBe('needs_action');
  expect(db.read('pins','pin').placeName).toBe('Cafe');
  await service.process('pin');expect(fetch).toHaveBeenCalledTimes(1);
  expect(await service.retry('pin','u',1,taskId())).toEqual({status:'queued',revision:2});
  expect(await service.retry('pin','u',1,taskId())).toEqual({status:'queued',revision:2});
  await service.process('pin');
  expect(fetch).toHaveBeenCalledTimes(2);expect(db.read('pins','pin').detailsState).toBe('complete');
  expect(await service.retry('pin','u',1,taskId())).toEqual({status:'complete',revision:2});
});
test('a different user and invented pin cannot trigger paid details',async()=>{
  await seed();await expect(service.retry('pin','other',1,taskId())).rejects.toMatchObject({code:'access_blocked'});
  await expect(service.retry('invented','u',1,taskId())).rejects.toMatchObject({code:'access_blocked'});
  expect(fetch).not.toHaveBeenCalled();
});
test.each(['deleted','recreated','newPlace','deletedUser'])('stale %s pin cancels before any dispatch',async mode=>{
  await seed();time+=10;
  if(mode==='deleted')await db.collection('pins').doc('pin').delete();
  if(mode==='recreated'){await db.collection('pins').doc('pin').delete();await db.collection('pins').doc('pin').set(pin());}
  if(mode==='newPlace')await db.collection('pins').doc('pin').update({placeId:'different'});
  if(mode==='deletedUser')await db.collection('users').doc('u').delete();
  expect(await service.process('pin')).toBe('skipped');expect(fetch).not.toHaveBeenCalled();
  expect(db.read('pinDetailTasks','pin').status).toBe('cancelled');
});
test('an edited category and notes during fetch survive a late provider result',async()=>{
  await seed();fetch.mockImplementationOnce(async()=>{
    await context.current().beforeProviderDispatch();
    await db.collection('pins').doc('pin').update({category:'bars',notes:'user edit',listIds:['new']});
    return details();
  });
  await service.process('pin');
  expect(db.read('pins','pin')).toMatchObject({category:'bars',notes:'user edit',listIds:['new'],rating:4.5});
});
test('manual edit provenance preserves a field even if it returned to its old value',async()=>{
  await seed();await db.collection('pins').doc('pin').update({detailsUserEditedFields:['category']});
  await service.process('pin');expect(db.read('pins','pin').category).toBe('other');
});
test('same-value legacy edits with unchanged commit metadata preserve accepted core fields, including zero coordinates',async()=>{
  await seed('pin',{...pin(),latitude:0,longitude:0});
  // Deliberately keep the fake clock fixed: there is no timestamp evidence of
  // this old-client edit, and no modern edit marker to consult.
  await db.collection('pins').doc('pin').update({category:'other'});
  fetch.mockImplementationOnce(async()=>{
    await context.current().beforeProviderDispatch();
    return {...details(),name:'Provider rename',formatted_address:'Another address'};
  });
  expect(await service.process('pin')).toBe('complete');
  expect(db.read('pinDetailTasks','pin').protectMutableFields).toBe(false);
  expect(db.read('pins','pin')).toMatchObject({placeName:'Cafe',formattedAddress:'Kyoto, Japan',
    latitude:0,longitude:0,category:'other',city:'Kyoto',rating:4.5,servesCoffee:true});
});
test('concurrent worker claims dispatch only one request',async()=>{
  await seed();await Promise.all([service.process('pin'),service.process('pin')]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('failure to commit outbox rolls back the pin too',async()=>{
  db.setWriteFailure(collection=>collection==='pinDetailTasks'?new Error('outbox failure'):null);
  await expect(seed()).rejects.toThrow('outbox failure');expect(db.read('pins','pin')).toBeUndefined();
});
test('expired dispatched work becomes needs-action and is never automatically retried',async()=>{
  await seed();let release;
  fetch.mockImplementationOnce(async()=>{await context.current().beforeProviderDispatch();return new Promise(r=>{release=r;});});
  const running=service.process('pin');
  while(!release)await new Promise(r=>setImmediate(r));
  time+=50000;await service.expire('pin');release(details());
  expect(await running).toBe('stale');expect(db.read('pins','pin').detailsState).toBe('needs_action');
  await service.process('pin');expect(fetch).toHaveBeenCalledTimes(1);
});
test('pin deletion after dispatch never recreates it',async()=>{
  await seed();fetch.mockImplementationOnce(async()=>{
    await context.current().beforeProviderDispatch();await db.collection('pins').doc('pin').delete();return details();
  });
  expect(await service.process('pin')).toBe('cancelled');expect(db.read('pins','pin')).toBeUndefined();
});

test('corrected queued pin clears pending and explicitly recovers one new revision',async()=>{
  await seed();const originalTaskId=taskId();time++;
  await db.collection('pins').doc('pin').update({placeId:'corrected',placeName:'Correct Cafe'});
  expect(await service.process('pin')).toBe('skipped');
  expect(db.read('pins','pin')).toMatchObject({detailsState:'needs_action',detailsTaskId:originalTaskId,detailsRevision:1});
  expect(fetch).not.toHaveBeenCalled();
  await expect(service.retry('pin','other',1,originalTaskId)).rejects.toMatchObject({code:'access_blocked'});
  time++;
  const retries=await Promise.all([service.retry('pin','u',1,originalTaskId),service.retry('pin','u',1,originalTaskId)]);
  expect(retries).toEqual([{status:'queued',revision:2},{status:'queued',revision:2}]);
  expect(await service.process('pin')).toBe('complete');
  expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toBe('corrected');
  expect(db.read('pins','pin')).toMatchObject({placeName:'Correct Cafe',detailsState:'complete',rating:4.5});
  expect(await service.retry('pin','u',1,originalTaskId)).toEqual({status:'complete',revision:2});
});

test('explicit correction replacement fences a running old producer',async()=>{
  await seed();let release;
  fetch.mockImplementationOnce(async()=>{
    await context.current().beforeProviderDispatch();return new Promise(resolve=>{release=resolve;});
  });
  const old=service.process('pin');while(!release)await new Promise(resolve=>setImmediate(resolve));
  time++;await db.collection('pins').doc('pin').update({placeId:'corrected',detailsState:'needs_action'});
  await service.retry('pin','u',1,taskId());await service.process('pin');
  release({...details(),rating:1});expect(await old).toBe('stale');
  expect(db.read('pins','pin')).toMatchObject({placeId:'corrected',detailsState:'complete',detailsRevision:2,rating:4.5});
});

test('repeatable dispatch validation stays read-only and observes revocation after the one-shot mark',async()=>{
  await seed();fetch.mockImplementationOnce(async()=>{
    const ctx=context.current();
    await ctx.validateProviderDispatch();await ctx.validateProviderDispatch();
    expect(db.read('pinDetailTasks','pin').dispatched).toBe(false);
    await ctx.beforeProviderDispatch();const before=db.read('pinDetailTasks','pin');
    await ctx.validateProviderDispatch();expect(db.read('pinDetailTasks','pin')).toEqual(before);
    time++;await db.collection('pins').doc('pin').update({placeId:'corrected'});
    await expect(ctx.validateProviderDispatch()).rejects.toMatchObject({code:'attempt_stopped'});
    return details();
  });
  expect(await service.process('pin')).toBe('cancelled');
  expect(db.read('pins','pin').detailsState).toBe('needs_action');
});

test.each(['before claim','during fetch','before retry'])('legacy same-value category edit %s survives while optional metadata fills',async when=>{
  await seed();
  const edit=async()=>{time++;await db.collection('pins').doc('pin').update({category:'other',updatedAt:admin.firestore.FieldValue.serverTimestamp()});};
  if(when==='before claim')await edit();
  if(when==='before retry'){
    fetch.mockRejectedValueOnce(new Error('offline'));await service.process('pin');
    await edit();time++;await service.retry('pin','u',1,taskId());
  }
  if(when==='during fetch')fetch.mockImplementationOnce(async()=>{await context.current().beforeProviderDispatch();await edit();return details();});
  expect(await service.process('pin')).toBe('complete');
  expect(db.read('pins','pin')).toMatchObject({category:'other',rating:4.5,servesCoffee:true});
  expect(db.read('pinDetailTasks','pin').protectMutableFields).toBe(true);
});

test('server-only retry fills missing core fields but preserves populated accepted fields',async()=>{
  await seed();time++;fetch.mockRejectedValueOnce(new Error('offline'));await service.process('pin');
  time++;await service.retry('pin','u',1,taskId());time++;
  expect(await service.process('pin')).toBe('complete');
  expect(db.read('pins','pin')).toMatchObject({category:'other',city:'Kyoto',rating:4.5});
  expect(db.read('pinDetailTasks','pin').protectMutableFields).toBe(false);
});

test('legacy tasks missing server write provenance conservatively preserve mutable fields',async()=>{
  await seed();const ref=db.collection('pinDetailTasks').doc('pin');
  const {pinWriteSameCommit,...legacy}=db.read('pinDetailTasks','pin');await ref.set(legacy);
  expect(await service.process('pin')).toBe('complete');
  expect(db.read('pins','pin')).toMatchObject({category:'other',rating:4.5});
});

test('cancelled initial task retains original generation and cannot authorize a recreated pin',async()=>{
  await seed();const originalTaskId=taskId();time++;
  await db.collection('pins').doc('pin').delete();await service.process('pin');
  time++;await db.collection('pins').doc('pin').set({...pin(),placeId:'replacement',detailsTaskId:originalTaskId});
  await expect(service.retry('pin','u',1,originalTaskId)).rejects.toMatchObject({code:'access_blocked'});
  expect(fetch).not.toHaveBeenCalled();
});
