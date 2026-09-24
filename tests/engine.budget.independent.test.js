// Independent adversarial review: no real datastore/provider/network is used.
const {execFileSync} = require('child_process');
const path = require('path');
const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createEngineBudget,COLLECTIONS,counterId,DEFAULT_POLICY} = require('../lib/engineBudget');
const {createBudgetHarness} = require('./helpers/engineBudgetHarness');
const day='2026-09-18';
const descriptor={maxInputTokens:1000,maxImageTokens:0,maxOutputTokens:200,cacheEnabled:false};
function setup(extra={}) {
  const db=new FakeFirestore();db.strictReadOrder=true;
  const budget=createBudgetHarness({db,logger:null,now:()=>Date.parse(`${day}T12:00:00Z`),...extra});
  const h=budget.beginProviderObservation({provider:'anthropic',stage:'ai',rateKey:'haiku',descriptor,
    context:{verifiedUID:'review-private-user',attemptId:'review-private-attempt'}});
  return {db,h,row:()=>db.read(COLLECTIONS.calls,h.id),counter:()=>db.read(COLLECTIONS.counters,counterId('global','engine',day))};
}

test('void observation calls cannot crash strict-unhandled-rejection Node on late datastore or logger failure',()=>{
  const script=`
    const {createEngineBudget}=require('./lib/engineBudget');
    const pending=[];
    const budget=createEngineBudget({timeoutMs:2,journal:null,
      logger:{warn(){return Promise.reject(new Error('private logger rejection'));}},
      db:{collection(){return {doc(){return {};}};},runTransaction(){
        return new Promise((resolve,reject)=>{pending.push(reject);});
      }}});
    const h=budget.beginProviderObservation({provider:'google',rateKey:'places_details',context:{userId:'review-user'}});
    void h.markDispatched();
    void h.settle({result:{},dispatched:true});
    void h.releaseUnsent();
    setTimeout(()=>{for(const reject of pending) reject(new Error('late private database rejection'));},30);
    setTimeout(()=>{process.stdout.write('survived');},60);
  `;
  const result=execFileSync(process.execPath,['--unhandled-rejections=strict','-e',script],
    {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:3000,env:{...process.env,NODE_ENV:'test'}});
  expect(result).toBe('survived');
});

test('deleted accounts are never recreated by observation, including enforcement-looking policy',async()=>{
  const s=setup({policy:{...DEFAULT_POLICY,mode:'enforce',emergencyStop:true,
    limits:{attemptCalls:0,attemptMicrodollars:0,accountDayMicrodollars:0,globalDayMicrodollars:0}}});
  s.db.seed('users','review-private-user',{});await s.db.collection('users').doc('review-private-user').delete();
  void s.h.markDispatched();
  expect(await s.h.settle({result:{usage:{input_tokens:0,output_tokens:0}},dispatched:true})).toMatchObject({mode:'observe',recorded:true});
  expect(s.row()).toMatchObject({actualMicrodollars:0,unknownLiability:false});
  expect(s.db.read('users','review-private-user')).toBeUndefined();
  expect([...s.db.collections.keys()].filter(name=>name.startsWith('users/'))).toEqual([]);
  const stored=JSON.stringify([...s.db.collections].map(([key,values])=>[key,[...values]]));
  expect(stored).not.toContain('review-private-user');expect(stored).not.toContain('review-private-attempt');
});

test.each([undefined,null,NaN,Infinity,-1,'0'])('unknown usage %s never settles as zero',async value=>{
  const s=setup();void s.h.markDispatched();
  await s.h.settle({result:{usage:{input_tokens:value,output_tokens:value}}});
  expect(s.row().actualMicrodollars).toBeNull();
  expect(s.counter()).toMatchObject({physicalCalls:1,settledCalls:0,unresolvedCalls:1,uncertainLiabilityMicrodollars:2000});
});

test('reordered releases and partial settlements retain one physical call and conserve known plus held liability',async()=>{
  const s=setup();void s.h.markDispatched();
  await s.h.settle({result:{usage:{input_tokens:100}}});
  await s.h.releaseUnsent();await s.h.settle({dispatched:false});
  expect(s.counter()).toMatchObject({physicalCalls:1,knownActualMicrodollars:100,uncertainLiabilityMicrodollars:1900,settledCalls:0});
  await Promise.all([s.h.settle({result:{usage:{input_tokens:100,output_tokens:20}}}),s.h.releaseUnsent(),s.h.settle({result:{usage:{input_tokens:100,output_tokens:20}}})]);
  expect(s.counter()).toMatchObject({physicalCalls:1,knownActualMicrodollars:200,uncertainLiabilityMicrodollars:0,settledCalls:1,unresolvedCalls:0});
});

// Finding: an unusable or exceeded token bound cannot justify a finite risk hold.
test('reported cost overflow must become unknown liability, not a small finite ceiling',async()=>{
  const s=setup();await s.h.markDispatched();
  await s.h.settle({result:{usage:{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:1,
    cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
  expect(s.row()).toMatchObject({actualMicrodollars:null,unknownLiability:true,uncertainLiabilityMicrodollars:null});
  expect(s.counter().unknownLiabilityCalls).toBe(1);
});

test('partial usage exceeding an input-token bound must invalidate the old finite hold',async()=>{
  const s=setup();await s.h.markDispatched();
  // Input alone is $0.0015; missing output may still reach $0.001 under its
  // declared 200-token bound. The old $0.002 total no longer bounds this call.
  await s.h.settle({result:{usage:{input_tokens:1500}}});
  expect(s.row()).toMatchObject({actualMicrodollars:null,knownActualMicrodollars:1500,unknownLiability:true});
  expect(s.counter().unknownLiabilityCalls).toBe(1);
});
