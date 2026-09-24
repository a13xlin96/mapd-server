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
