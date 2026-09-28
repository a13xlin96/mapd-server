'use strict';
jest.mock('../lib/cache',()=>({redis:null}));
jest.mock('../lib/firestore',()=>({firestore:null}));
const {FakeFirestore}=require('./helpers/fakeFirestore');
const {createTranscriptionService,SERVER_PUBLIC_SCOPE}=require('../lib/media/transcriptionService');
const {createSharedAiOperations}=require('../lib/sharedAiOperation');
const {COLLECTION}=require('../lib/sharedAiStore');
const {identity}=require('../lib/sharedAiIdentity');
const jobContext=require('../lib/jobContext');
// Installed SDK internals only: no Firestore client, credentials, emulator or
// network. Pin this test to the same validation/encoding used by SDK writes.
require('@google-cloud/firestore'); // Initialize public exports before circular internal imports.
const sdkRoot=require('path').dirname(require.resolve('@google-cloud/firestore/package.json'));
const {validateDocumentData}=require(require('path').join(sdkRoot,'build/src/write-batch'));
const {Serializer}=require(require('path').join(sdkRoot,'build/src/serializer'));

// Firestore rejects an array directly inside another array, including deep
// inside a map. Arrays inside intervening maps are legal. Sort map keys too:
// durable reads must not depend on the producer's object insertion order.
function firestoreValue(value,inArray=false) {
  if(Array.isArray(value)) {
    if(inArray)throw new Error('Firestore cannot store directly nested arrays');
    return value.map(item=>firestoreValue(item,true));
  }
  if(value && typeof value==='object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,firestoreValue(value[key])]));
  }
  return value;
}
class StrictFirestore extends FakeFirestore {
  constructor(){super();this.strictReadOrder=true;}
  collection(name) {
    const collection=super.collection(name),doc=collection.doc.bind(collection);
    collection.doc=id=>{
      const ref=doc(id),write=ref._setSync.bind(ref);
      // Covers ordinary set/update and the real store's transaction writes.
      ref._setSync=(value,options)=>write(firestoreValue(value),options);
      return ref;
    };
    return collection;
  }
}
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function until(predicate) {
  for(let i=0;i<500;i++) {if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}
  throw new Error('Durable follower did not subscribe');
}
const input={mediaDigest:'a'.repeat(64),durationMs:20000,
  chunks:[{audioBytes:Buffer.from('RIFF0000WAVEoffline-test-only'),startMs:0,endMs:20000}]};
function setup() {
  const db=new StrictFirestore();
  const provider={id:'openai',model:'gpt-4o-mini-transcribe-2025-12-15',version:'persistence-test-v1',
    transcribeChunk:jest.fn(async()=>({text:'Phở Phượng',language:'vi',usage:{input_tokens:10}}))};
  const providerCall=jest.fn(async(_provider,work)=>{
    await jobContext.current().sharedOperation.authorizeDispatch();
    return work();
  });
  function client() {
    // No cache and no local fallback: every fresh coordinator must read the
    // real shared-operation store over this fake Firestore.
    const operations=createSharedAiOperations({firestore:db,limits:{pollMs:5}});
    const sharedOperation=jest.fn(operations.runSharedAiOperation);
    const service=createTranscriptionService({providers:{openai:provider},sharedOperation,providerCall});
    return {sharedOperation,run:()=>service.transcribe(input,{scope:SERVER_PUBLIC_SCOPE,requestTimeoutMs:1000})};
  }
  const records=()=>[...(db.collections.get(COLLECTION)?.entries() || [])].filter(([,value])=>value.kind==='asr_chunk');
  return {db,provider,providerCall,client,records};
}

test('fake Firestore rejects nested arrays recursively on direct and transactional writes but accepts interval maps',async()=>{
  const db=new StrictFirestore(),ref=db.collection('test').doc('value');
  await expect(ref.set({deep:{coverage:{intervals:[[0,20000]]}}})).rejects.toThrow('nested arrays');
  await expect(db.runTransaction(tx=>tx.set(ref,{outer:[{deep:{intervals:[[0,1]]}}]}))).rejects.toThrow('nested arrays');
  expect((await ref.get()).exists).toBe(false);
  await ref.set({coverage:{intervals:[{startMs:0,endMs:20000}]},legal:[{array:[1,2]}]});
  expect((await ref.get()).data().coverage.intervals).toEqual([{startMs:0,endMs:20000}]);
});

test('successful ASR persists interval maps; a durable follower and fresh replay share one physical dispatch',async()=>{
  const f=setup(),entered=gate(),held=gate(),leader=f.client(),follower=f.client();
  f.provider.transcribeChunk.mockImplementation(async()=>{
    entered.release();await held.promise;
    return {text:'Phở Phượng',language:'vi',usage:{input_tokens:10}};
  });
  const first=leader.run();let second;
  try {
    await entered.promise;
    second=follower.run();
    await until(()=>f.records().some(([,record])=>Object.keys(record.subscribers || {}).length===2));
    held.release();
    const [a,b]=await Promise.all([first,second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({text:'Phở Phượng',coverage:{status:'complete',intervals:[[0,20000]]},failures:[],retryOperations:[]});
    const options=leader.sharedOperation.mock.calls[0][0];
    expect(options.schemaVersion).toBe(2);
    const key=identity(options).key;
    expect(f.db.read(COLLECTION,identity({...options,schemaVersion:1}).key)).toBeUndefined();
    expect(f.records()).toHaveLength(1);
    const record=f.db.read(COLLECTION,`${key}_1`);
    expect(record).toMatchObject({state:'complete',generation:1,result:{coverage:{status:'complete',intervals:[{startMs:0,endMs:20000}]}}});
    expect(record.dispatch).toBeTruthy();
    expect(options.validate(record.result)).toBe(true);
    expect(JSON.stringify(record.result)).not.toMatch(/usage|input_tokens|audioBytes/);
    const replay=await f.client().run();
    expect(replay).toEqual(a);
    expect(f.provider.transcribeChunk).toHaveBeenCalledTimes(1);
    expect(f.providerCall).toHaveBeenCalledTimes(1);
    expect(f.records()).toHaveLength(1);
    expect([...f.db.collections.keys()].sort()).toEqual(['engineControl',COLLECTION].sort());
  } finally {
    held.release();await Promise.allSettled([first,...(second?[second]:[])]);
  }
});

test('the actual Firestore SDK validates and encodes persisted ASR coverage as array-of-map protobuf values',async()=>{
  const f=setup();await f.client().run();
  const [[,record]]=f.records();
  expect(record.state).toBe('complete');
  expect(()=>validateDocumentData('artifact',record.result,false,false)).not.toThrow();
  const serializer=new Serializer({_settings:{},doc:()=>{throw new Error('Unexpected document reference');}});
  const encoded=serializer.encodeFields(record.result);
  expect(encoded.coverage.mapValue.fields.intervals).toEqual({arrayValue:{values:[{mapValue:{fields:{
    startMs:{integerValue:0},endMs:{integerValue:20000},
  }}}]}});
  // This SDK version's serializer alone also encodes prohibited nested
  // arrays. Assert the actual wire shape rather than assuming validation
  // rejects them before the server does.
  const validateWire=value=>{
    if(value?.arrayValue) {
      for(const item of value.arrayValue.values || []) {
        if(item.arrayValue)throw new Error('Directly nested arrayValue');
        validateWire(item);
      }
    }
    for(const item of Object.values(value?.mapValue?.fields || {}))validateWire(item);
  };
  expect(()=>validateWire({mapValue:{fields:encoded}})).not.toThrow();
  expect(()=>validateWire(serializer.encodeValue([[0,20000]]))).toThrow('nested arrayValue');
});

test.each([
  ['expanded interval',value=>{value.coverage.intervals[0].endMs=20001;}],
  ['shifted interval',value=>{value.coverage.intervals[0].startMs=1;}],
  ['empty intervals',value=>{value.coverage.intervals=[];}],
  ['extra interval',value=>{value.coverage.intervals.push({startMs:0,endMs:20000});}],
  ['forged status',value=>{value.coverage.status='partial';}],
  ['extra interval field',value=>{value.coverage.intervals[0].trusted=true;}],
  ['extra coverage field',value=>{value.coverage.reason='forged';}],
  ['extra artifact field',value=>{value.usage={input_tokens:10};}],
  ['extra segment field',value=>{value.segments[0].trusted=true;}],
  ['forged segment timing',value=>{value.segments[0].endMs=20001;}],
  ['wrong provider',value=>{value.provider='forged';}],
  ['obsolete interval pairs',value=>{value.coverage.intervals=[[0,20000]];}],
])('durable replay rejects %s without returning forged evidence or dispatching again',async(_name,forge)=>{
  const f=setup(),leader=f.client(),good=await leader.run();
  expect(good.coverage.status).toBe('complete');
  const [[recordId,record]]=f.records();
  const poisoned=structuredClone(record);forge(poisoned.result);
  expect(leader.sharedOperation.mock.calls[0][0].validate(poisoned.result)).toBe(false);
  // Seed models corrupted/obsolete stored input, deliberately bypassing the
  // write validator so even impossible legacy shapes exercise read rejection.
  f.db.seed(COLLECTION,recordId,poisoned);
  const replay=await f.client().run();
  expect(replay).toMatchObject({text:'',segments:[],coverage:{status:'failed',intervals:[]},
    failures:[{code:'invalid_response'}],retryOperations:[]});
  expect(f.provider.transcribeChunk).toHaveBeenCalledTimes(1);
  expect(f.providerCall).toHaveBeenCalledTimes(1);
  expect(f.records()).toHaveLength(1);
  expect(f.db.read(COLLECTION,recordId).state).toBe('complete');
});
