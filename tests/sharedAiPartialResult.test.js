const {FakeFirestore}=require('./helpers/fakeFirestore');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const {COLLECTION}=require('../lib/sharedAiStore');
const {identity}=require('../lib/sharedAiIdentity');
const partial={places:[{name:'PRIVATE_GROUNDED_PLACE'}],grounding:{omittedClaims:1,omittedCandidates:0}};
const full={places:[{name:'PRIVATE_GROUNDED_PLACE'}],grounding:{omittedClaims:0,omittedCandidates:0}};
const options=()=>({kind:'media_fusion',input:{text:'PRIVATE_INPUT'},scope:SERVER_PUBLIC_SCOPE,
  model:'test',promptVersion:'1',schemaVersion:5,optionsVersion:'1',ttlSeconds:()=>120,
  validate:v=>Array.isArray(v?.places)&&v.places.length===1&&v.places[0].name==='PRIVATE_GROUNDED_PLACE'
    &&[0,1].includes(v.grounding?.omittedClaims),retryableResult:v=>v.grounding.omittedClaims>0});
const hold=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function setup() {
  let time=1000;const firestore=new FakeFirestore(),cache={getCached:jest.fn(),setCache:jest.fn()};
  const deps={firestore,cache,now:()=>time,limits:{pollMs:5}};
  return {firestore,cache,a:createSharedAiOperations(deps),b:createSharedAiOperations(deps),advance:ms=>{time+=ms;}};
}
const capture=p=>p.catch(e=>e);
test('cross-process partial followers reuse one paid attempt, and explicit retries share one successor',async()=>{
  const f=setup(),ready=hold(),finish=hold();
  const work=jest.fn(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();ready.resolve();return finish.promise;});
  const one=capture(f.a.runSharedAiOperation(options(),work));await ready.promise;
  const two=capture(f.b.runSharedAiOperation(options(),work));finish.resolve(partial);
  const failures=await Promise.all([one,two]);
  for(const error of failures) {
    expect(error).toMatchObject({code:'invalid_response',retryGeneration:1});
    expect(error.partialResult).toEqual(partial);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  }
  const warm=await capture(f.b.runSharedAiOperation(options(),work));
  expect(warm.partialResult).toEqual(partial);expect(work).toHaveBeenCalledTimes(1);
  expect(f.cache.setCache).not.toHaveBeenCalled();
  work.mockImplementation(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return full;});
  expect(await Promise.all([f.a,f.b].map(c=>c.runSharedAiOperation({...options(),retryGeneration:1},work)))).toEqual([full,full]);
  await f.a.runSharedAiOperation({...options(),retryGeneration:1},work);
  await f.b.runSharedAiOperation(options(),work);expect(work).toHaveBeenCalledTimes(2);
});
test('every local follower revalidates partials with its own validator',async()=>{
  const f=setup(),ready=hold(),finish=hold();
  const work=jest.fn(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();ready.resolve();return finish.promise;});
  const leader=capture(f.a.runSharedAiOperation(options(),work));await ready.promise;
  const follower=capture(f.a.runSharedAiOperation({...options(),validate:()=>false},work));
  finish.resolve(partial);
  expect((await leader).partialResult).toEqual(partial);
  const rejected=await follower;
  expect(rejected.partialResult).toBeUndefined();expect(rejected.retryGeneration).toBe(1);
  expect(work).toHaveBeenCalledTimes(1);
});
test('cancelled subscribers cannot recover partial evidence',async()=>{
  const f=setup(),ready=hold(),finish=hold(),abort=new AbortController();
  const work=jest.fn(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();ready.resolve();return finish.promise;});
  const one=capture(f.a.runSharedAiOperation({...options(),signal:abort.signal},work));await ready.promise;
  const two=capture(f.b.runSharedAiOperation(options(),work));abort.abort();finish.resolve(partial);
  const cancelled=await one;expect(cancelled).toMatchObject({code:'attempt_stopped'});
  expect(cancelled.partialResult).toBeUndefined();expect((await two).partialResult).toEqual(partial);
});
test('expired partial evidence is withheld without removing its explicit-retry fence',async()=>{
  const f=setup(),work=jest.fn(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return partial;});
  await capture(f.a.runSharedAiOperation(options(),work));
  const key=identity(options()).key,stored=f.firestore.read(COLLECTION,`${key}_1`);
  expect(stored).toMatchObject({state:'failed',partialResultUntil:121000});
  expect(stored.failure).not.toHaveProperty('partialResult');
  f.advance(120001);
  const failure=await capture(f.b.runSharedAiOperation(options(),work));
  expect(failure.partialResult).toBeUndefined();expect(failure.retryGeneration).toBe(1);
  expect(work).toHaveBeenCalledTimes(1);
});
test('invalid or oversized partials never become persisted recovery artifacts',async()=>{
  const f=setup(),work=jest.fn(async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return {...partial,extra:'x'.repeat(66000)};});
  const error=await capture(f.a.runSharedAiOperation(options(),work));
  expect(error).toMatchObject({code:'invalid_response'});expect(error.partialResult).toBeUndefined();
  const rows=[...f.firestore.collections.get(COLLECTION).values()];
  expect(rows.some(r=>r.partialResult)).toBe(false);
});
