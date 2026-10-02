'use strict';
const assert=require('node:assert/strict');
const {createVideoEvidence}=require('../../lib/media/videoEvidence');
const {createEngineFeatures}=require('../../lib/engineFeatures');
const {processMedia}=require('../../lib/media/mediaProcess');
const {prepareAudioChunks}=require('../../lib/media/audioDecode');
const jobContext=require('../../lib/jobContext');

// Exercise the real coordinator, probing and audio decode with the shipped
// binaries. Provider adapters are explicit stubs: this is not an accuracy test.
module.exports=async function audioOnlySmoke(media,deps) {
  const features=createEngineFeatures({snapshotVersion:2,internalUids:['fixture'],flags:{mediaEvidence:true},
    mediaPolicy:{policyVersion:'media-v2',analysisMode:'audio-only'}}).forJob('fixture',undefined,['mediaRecoveryV1']);
  let chunks=0,disposed=false;
  const release=media.retain();
  const collector=createVideoEvidence({
    discover:async()=>({availability:'available'}),
    acquire:async()=>({...media,dispose:async()=>{disposed=true;await release();}}),
    probe:input=>processMedia(input,deps),audio:input=>prepareAudioChunks(input,deps),
    readManifest:async()=>null,writeManifest:async()=>{},
    frames:async()=>assert.fail('audio-only must not decode frames'),
    vision:async()=>assert.fail('audio-only must not make a vision request'),
    transcribe:async input=>{
      chunks=input.chunks.length;assert(chunks>0,'audio was not decoded');
      for(const chunk of input.chunks) {
        const pcm=chunk.audioBytes.subarray(44);let energy=0;
        for(let i=0;i<pcm.length;i+=2)energy+=pcm.readInt16LE(i)**2;
        assert(pcm.length>0 && Math.sqrt(energy/(pcm.length/2))>100,'audio samples are silent');
      }
      return {segments:[{text:'Fixture Cafe',evidenceId:'audio:fixture',origin:'audio',startMs:0,endMs:input.durationMs}],
        coverage:{status:'complete',intervals:[[0,input.durationMs]]},retryOperations:[]};
    },
    fusion:async input=>{
      assert.equal(input.textEvidence.filter(e=>e.modality==='transcript').length,1);
      assert.equal(input.textEvidence.filter(e=>e.modality==='visual').length,0);
      return {places:[{name:'Fixture Cafe',evidenceRefs:[{evidenceId:'audio:fixture',quote:'Fixture Cafe',supports:'name'}]}]};
    },
  });
  try {
    const result=await jobContext.run({features,userId:'fixture',deadline:Date.now()+120000},()=>collector({url:'offline-fixture'}));
    assert.equal(result.incomplete,false);assert.equal(result.places[0].requiresSelection,true);
    assert.deepEqual(result.coverage.visual,{status:'unavailable',reason:'disabled_by_policy',intervals:[]});
    assert.equal(disposed,true);
    return {chunks,realDecode:true,frameCalls:0,visionCalls:0,providerStubs:true};
  } finally {if(!disposed)await release();}
};
