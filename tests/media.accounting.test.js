jest.mock('../lib/cache', () => ({redis:null}));
jest.mock('../lib/firestore', () => ({firestore:null}));
jest.mock('../lib/engineBudget', () => ({...jest.requireActual('../lib/engineBudget'),beginProviderObservation:jest.fn()}));
const fs=require('fs/promises'), os=require('os'), path=require('path');
const budget=require('../lib/engineBudget');
const {createEngineBudgetWorker}=require('../lib/engineBudgetWorker');
const {FakeFirestore}=require('./helpers/fakeFirestore');
const metrics=require('../lib/engineMetrics');
const {withProvider}=require('../lib/providerRuntime');
const job=require('../lib/jobContext');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const clone=v=>JSON.parse(JSON.stringify(v));
const DAY='2026-09-21', MODEL='gpt-4o-mini-transcribe-2025-12-15';
const input={provider:'openai',stage:'transcription',rateKey:'openai_mini_transcribe',
  descriptor:{model:MODEL,audioSeconds:60,cacheEnabled:false},context:{userId:'synthetic',jobId:'synthetic-job'}};
const usage={input_tokens:120,output_tokens:10,input_token_details:{audio_tokens:100,text_tokens:20}};
function table() {const p=clone(budget.DEFAULT_MEDIA_PRICES);
  p.rates.openai_mini_transcribe.microdollarsPerMillion={textInput:1000000,audioInput:2000000,output:4000000};return p;}
function setup(extra={}) {const db=new FakeFirestore();db.strictReadOrder=true;
  const ledger=budget.createEngineBudget({db,journal:null,logger:null,prices:table(),now:()=>`${DAY}T00:00:00.000Z`,...extra});
  const row=h=>db.read(budget.COLLECTIONS.calls,h.id);
  return {db,ledger,row,global:()=>db.read(budget.COLLECTIONS.counters,budget.counterId('global','engine',DAY)),
    async drain(){await ledger.flushPendingWrites();await createEngineBudgetWorker({db,journal:null,logger:null}).tick();}};}

test('separate audio/text/output tokens charge once; duration is only a planning estimate',async()=>{
  const s=setup(),h=s.ledger.beginProviderObservation(input);
  await h.markDispatched();await h.settle({result:{usage}});await s.drain();
  expect(s.row(h)).toMatchObject({schemaVersion:2,provider:'openai',stage:'transcription',rateKey:'openai_mini_transcribe',
    actualMicrodollars:260,knownActualMicrodollars:260,durationEstimateMicrodollars:3000,
    usage:{input:120,audioInput:100,textInput:20,output:10}});
  expect(s.global()).toMatchObject({physicalCalls:1,knownActualMicrodollars:260,settledCalls:1});
});

test.each([undefined,{input_tokens:120,output_tokens:10},
  {input_tokens:120,output_tokens:10,input_token_details:{audio_tokens:100}},
  {input_tokens:119,output_tokens:10,input_token_details:{audio_tokens:100,text_tokens:20}},
  {type:'duration',seconds:60},
])('missing/contradictory usage stays unknown, never substituted by the duration estimate: %j',async reported=>{
  const s=setup(),h=s.ledger.beginProviderObservation(input);
  await h.settle({result:{usage:reported}});await s.drain();
  expect(s.row(h)).toMatchObject({state:'uncertain',actualMicrodollars:null,durationEstimateMicrodollars:3000});
  expect(s.global().unknownLiabilityCalls).toBe(1);
});

test('explicit zero usage is known; audio bound breach preserves unbounded liability',async()=>{
  const s=setup(),h=s.ledger.beginProviderObservation(input);
  await h.settle({result:{usage:{input_tokens:0,output_tokens:0,input_token_details:{audio_tokens:0,text_tokens:0}}}});
  expect(s.row(h).actualMicrodollars).toBe(0);
  const over=s.ledger.beginProviderObservation({...input,descriptor:{...input.descriptor,
    maxAudioInputTokens:90,maxTextInputTokens:20,maxOutputTokens:10}});
  await over.settle({result:{usage:{input_tokens:120,input_token_details:{audio_tokens:100,text_tokens:20}}}});
  expect(s.row(over)).toMatchObject({actualMicrodollars:null,unboundedUsage:true,unknownLiability:true});
});

test('v1 prices are still accepted; audio dimensions require explicit v2 schema',()=>{
  expect(budget.validatePrices(budget.DEFAULT_PRICES)).toEqual(budget.DEFAULT_PRICES);
  expect(budget.validatePrices(table())).toEqual(table());
  expect(()=>budget.validatePrices({...table(),schemaVersion:1})).toThrow();
  const invalid=table();invalid.rates.openai_mini_transcribe.microdollarsPerMillion.input=1000000;
  expect(()=>budget.validatePrices(invalid)).toThrow();
});

test('media metrics preserve dimensions and separate estimates; summary reads old v1 reports',()=>{
  const prices={schemaVersion:2,asOf:DAY,currency:'USD',rates:{openai_mini_transcribe:{provider:'openai',billing:'audio_tokens',
    usdPerMillion:{textInput:1,audioInput:2,output:4},estimateUsdPerMinute:.003}}};
  const m=metrics.createMetrics({prices});
  m.providerCall({provider:'openai',stage:'transcription',rateKey:'openai_mini_transcribe',outcome:'success',
    tokens:budget.usageFrom({usage},null,'openai'),submittedAudioSeconds:60});
  m.operation('audioSubmittedSeconds',60);m.recordStage('frame_selection',5);m.evidence({audio:true,video_frames:false});
  const report=m.finish('confirmation');
  expect(report.estimatedCost.totalUsd).toBeCloseTo(.00026);
  expect(report.providerCalls[0].durationEstimateUsd).toBe(.003);
  const old=metrics.createMetrics({prices:{schemaVersion:1,asOf:DAY,currency:'USD',rates:{}}}).finish('success');old.schemaVersion=1;
  const summary=metrics.summarizeMetrics([report,old]);
  expect(summary.overall.providers.openai.tokens.audioInput).toMatchObject({known:100,observedCalls:1});
  expect(summary.overall.cost.totalUsd).toBeCloseTo(.00026);
});

test('shared followers/cached results cause one physical observation; zero caps do not reject OpenAI work',async()=>{
  const s=setup({policy:{...budget.DEFAULT_POLICY,mode:'enforce',emergencyStop:true,
    limits:{attemptCalls:0,attemptMicrodollars:0,accountDayMicrodollars:0,globalDayMicrodollars:0}}});
  budget.beginProviderObservation.mockImplementation(args=>s.ledger.beginProviderObservation(args));
  const shared=createSharedAiOperations({firestore:s.db,limits:{pollMs:5}}),paid=jest.fn(async()=>{
    await new Promise(r=>setTimeout(r,15));return {usage,answer:'venue'};});
  const opts={kind:'asr_chunk',provider:'openai',scope:SERVER_PUBLIC_SCOPE,input:{digest:'b'.repeat(64)},model:MODEL,
    promptVersion:1,schemaVersion:1,optionsVersion:1,validate:r=>r?.answer==='venue'};
  const run=()=>job.run({...input.context,deadline:Date.now()+5000},()=>shared.runSharedAiOperation(opts,async()=>{
    const physical=await withProvider('openai',paid,1,input);
    return {answer:physical.answer}; // billing never enters the shared result
  }));
  const results=await Promise.all([run(),run()]);expect(results).toEqual([{answer:'venue'},{answer:'venue'}]);
  expect(await run()).toEqual({answer:'venue'});await s.drain();
  expect(paid).toHaveBeenCalledTimes(1);expect(s.global()).toMatchObject({physicalCalls:1,knownActualMicrodollars:260});
  expect(s.ledger.mode).toBe('observe');
});

test('journal recovery accepts old v1 and new v2 records and replays accounting only',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'media-ledger-test-'));
  try {
    const ledger=budget.createEngineBudget({db:null,logger:null,journalDirectory:directory,now:()=>`${DAY}T00:00:00.000Z`});
    for(const args of [input,{...input,provider:'google',stage:'matching',rateKey:'places_search',descriptor:{}}]) {
      const h=ledger.beginProviderObservation(args);await h.markDispatched();await h.settle({result:{usage}});
    }
    await ledger.flushPendingWrites();
    const versions=await Promise.all((await fs.readdir(directory)).map(async f=>JSON.parse(await fs.readFile(path.join(directory,f),'utf8')).seed.schemaVersion));
    expect(new Set(versions)).toEqual(new Set([1,2]));
    const db=new FakeFirestore(),worker=createEngineBudgetWorker({db,journalDirectory:directory,logger:null});
    expect((await worker.tick()).failed).toBe(0);await worker.tick();
    expect(await fs.readdir(directory)).toEqual([]);
    const rows=[...db.collections.get(budget.COLLECTIONS.calls).values()];
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.state==='settled')).toBe(true);
    expect(db.read(budget.COLLECTIONS.counters,budget.counterId('global','engine',DAY))).toMatchObject({physicalCalls:2,knownActualMicrodollars:32200});
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
