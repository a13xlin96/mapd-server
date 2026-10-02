'use strict';
const {createEngineFeatures,forExecution} = require('../lib/engineFeatures');
const {mediaConfigForFeatures,DEFAULT_MEDIA_CONFIG,validateMediaConfig} = require('../lib/media/mediaConfig');
const {assertMediaFleet} = require('../lib/engineRuntimeConfig');
const options = {snapshotVersion:2,internalUids:['staff'],flags:{mediaEvidence:true}};
test('old recorded jobs remain byte-compatible and cannot gain media during rollout',()=>{
  const old = createEngineFeatures().forJob('staff');
  expect(old.schemaVersion).toBe(1);
  expect(createEngineFeatures(options).forJob('staff',old,['mediaRecoveryV1'])).toEqual(old);
  expect(mediaConfigForFeatures(old)).toBeNull();
});
test('new media requires server flag, selected cohort and recovery compatibility together',()=>{
  const controller = createEngineFeatures(options);
  expect(mediaConfigForFeatures(controller.forJob('staff'))).toBeNull();
  expect(mediaConfigForFeatures(controller.forJob('outsider',undefined,['mediaRecoveryV1']))).toBeNull();
  expect(mediaConfigForFeatures(controller.forJob('staff',undefined,['mediaRecoveryV1']))).toEqual(DEFAULT_MEDIA_CONFIG);
  expect(mediaConfigForFeatures(createEngineFeatures({snapshotVersion:2,internalUids:['staff']}).forJob('staff',undefined,['mediaRecoveryV1']))).toBeNull();
});
test('recorded v2 policy survives rollback and is deeply immutable',()=>{
  const snapshot = createEngineFeatures(options).forJob('staff',undefined,['mediaRecoveryV1']);
  const resumed = forExecution(JSON.parse(JSON.stringify(snapshot)));
  expect(resumed).toEqual(snapshot);
  expect(()=>{resumed.media.policy.model='changed';}).toThrow();
  expect(createEngineFeatures().forJob('staff',resumed)).toEqual(snapshot);
});
test('invalid and partial v2 snapshots cannot silently change policy',()=>{
  const snapshot = createEngineFeatures(options).forJob('staff',undefined,['mediaRecoveryV1']);
  for (const change of [{media:null},{cohort:'control'},{schemaVersion:3},{versions:{...snapshot.versions,mediaEvidence:'unknown'}}]) {
    expect(()=>forExecution({...snapshot,...change})).toThrow();
  }
  const policy={...snapshot.media.policy};delete policy.provider;
  expect(()=>forExecution({...snapshot,media:{...snapshot.media,policy}})).toThrow();
});
test('server config mutation and client object cannot enable a feature later',()=>{
  const config={...options,flags:{mediaEvidence:false}};
  const controller=createEngineFeatures(config); config.flags.mediaEvidence=true;
  expect(mediaConfigForFeatures(controller.forJob('staff',undefined,['mediaRecoveryV1']))).toBeNull();
  expect(mediaConfigForFeatures(createEngineFeatures(options).forJob('staff',undefined,{mediaRecoveryV1:true}))).toBeNull();
});
test('v2 writers require explicit compatible-fleet contract',async()=>{
  const snapshot=createEngineFeatures(options).forJob('staff');
  const db={collection:()=>({doc:()=>({})})};
  for(const contract of [undefined,{schemaVersion:1,writersEnabled:false,minimumReaderVersion:2},{schemaVersion:1,writersEnabled:true,minimumReaderVersion:1}]) {
    await expect(assertMediaFleet({get:async()=>({data:()=>contract})},db,snapshot)).rejects.toMatchObject({code:'dependency_error'});
  }
  await expect(assertMediaFleet({get:async()=>({data:()=>({schemaVersion:1,writersEnabled:true,minimumReaderVersion:2})})},db,snapshot)).resolves.toBeUndefined();
  await expect(assertMediaFleet({get:()=>{throw Error('must not read');}},db,{schemaVersion:1})).resolves.toBeUndefined();
});
test('invalid resource and provider configuration fails rather than enabling another model',()=>{
  for(const bad of [{model:'gpt-4o'},{provider:'unknown'},{maxDurationMs:999999},{audioOverlapMs:20000},{maxFrames:2},{maxSpend:0}]) expect(()=>validateMediaConfig(bad)).toThrow();
  expect(()=>createEngineFeatures({flags:{mediaEvidence:true}})).toThrow();
});

const audioPolicy={policyVersion:'media-v2',analysisMode:'audio-only'};
test('audio mode requires explicit version and never changes v1 defaults',()=>{
  expect(validateMediaConfig()).toEqual(DEFAULT_MEDIA_CONFIG);
  expect(validateMediaConfig()).not.toHaveProperty('analysisMode');
  expect(validateMediaConfig(audioPolicy)).toMatchObject(audioPolicy);
  for(const policy of [{analysisMode:'audio-only'},{policyVersion:'media-v2'},
    {policyVersion:'media-v2',analysisMode:'audio-video'},
    {policyVersion:'media-v2',analysisMode:false},{...audioPolicy,model:'other'},
    {...audioPolicy,mediaTimeoutMs:120000}])expect(()=>validateMediaConfig(policy)).toThrow();
});
test('recorded modes survive both directions of live rollback without filling omitted fields',()=>{
  const audio=createEngineFeatures({...options,mediaPolicy:audioPolicy});
  const both=createEngineFeatures(options);
  const a=audio.forJob('staff',undefined,['mediaRecoveryV1']);
  const b=both.forJob('staff',undefined,['mediaRecoveryV1']);
  expect(audio.forJob('staff',b)).toEqual(b);
  expect(both.forJob('staff',a)).toEqual(a);
  expect(forExecution(JSON.parse(JSON.stringify(a)))).toEqual(a);
  expect(()=>{a.media.policy.analysisMode='audio-video';}).toThrow();
  for(const field of ['analysisMode','provider','policyVersion','requestTimeoutMs']) {
    const broken=JSON.parse(JSON.stringify(a));delete broken.media.policy[field];
    expect(()=>forExecution(broken)).toThrow();
  }
});
test('audio-only still requires cohort and client capability and cannot upgrade admitted legacy work',()=>{
  const audio=createEngineFeatures({...options,mediaPolicy:audioPolicy});
  expect(mediaConfigForFeatures(audio.forJob('outsider',undefined,['mediaRecoveryV1']))).toBeNull();
  expect(mediaConfigForFeatures(audio.forJob('staff'))).toBeNull();
  const legacy=createEngineFeatures().forJob('staff');
  expect(audio.forJob('staff',legacy,['mediaRecoveryV1'])).toEqual(legacy);
});
test('audio-only requires a policy-reader fence while old modes retain the original contract',async()=>{
  const a=createEngineFeatures({...options,mediaPolicy:audioPolicy}).forJob('staff',undefined,['mediaRecoveryV1']);
  const b=createEngineFeatures(options).forJob('staff',undefined,['mediaRecoveryV1']);
  const db={collection:()=>({doc:()=>({})})};
  const base={schemaVersion:1,writersEnabled:true,minimumReaderVersion:2};
  const txn=control=>({get:async()=>({data:()=>control})});
  for(const marker of [undefined,1,'2',3])await expect(assertMediaFleet(txn({...base,minimumMediaPolicyVersion:marker}),db,a)).rejects.toMatchObject({code:'dependency_error',stage:'media_configuration'});
  await expect(assertMediaFleet(txn({...base,minimumMediaPolicyVersion:2}),db,a)).resolves.toBeUndefined();
  await expect(assertMediaFleet(txn(base),db,b)).resolves.toBeUndefined();
  await expect(assertMediaFleet(txn({...base,minimumMediaPolicyVersion:2}),db,b)).resolves.toBeUndefined();
});
