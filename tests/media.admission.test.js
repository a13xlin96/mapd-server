jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
const {getSharedFirestore}=require('./helpers/fakeFirestore');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {admitEnrichmentJob}=require('../lib/enrichAdmission');
const db=getSharedFirestore();
const features=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true}});
const request={jobId:'new',userId:'u',url:'https://example.org'};
beforeEach(()=>db.reset());
test('new schema writer fails closed without upgraded fleet marker',async()=>{
 expect(await admitEnrichmentJob(db,{...request,clientCapabilities:['mediaRecoveryV1']},{features})).toMatchObject({body:{status:'failed'}});
});
test('stored capture capability governs Cloud Function admission; caller cannot override stored capability',async()=>{
 db.seed('engineControl','mediaFleet',{schemaVersion:1,minimumReaderVersion:2,writersEnabled:true});
 db.seed('enrichmentJobs','new',{...request,status:'pending',clientCapabilities:['mediaRecoveryV1']});
 await admitEnrichmentJob(db,request,{features});
 expect(db.read('enrichmentJobs','new').engineFeatures.versions.mediaEvidence).toBe('media-evidence-v1');
 db.seed('enrichmentJobs','old',{userId:'u',url:request.url,status:'pending'});
 await admitEnrichmentJob(db,{...request,jobId:'old',clientCapabilities:['mediaRecoveryV1']},{features});
 expect(db.read('enrichmentJobs','old').engineFeatures.versions.mediaEvidence).toBe('legacy');
});
test('invalid retry and forged capability shape rejected before job creation',async()=>{
 for(const fields of [{retryKind:'analysis'},{clientCapabilities:'mediaRecoveryV1'},{clientCapabilities:['mediaRecoveryV1','mediaRecoveryV1']},{clientCapabilities:['unknown']},{retryOf:'x',retryKind:'automatic'}])
 expect(await admitEnrichmentJob(db,{...request,...fields},{features})).toMatchObject({code:400});
 expect(db.read('enrichmentJobs','new')).toBeUndefined();
});

test('audio-only admission requires upgraded policy readers and records the mode from the server',async()=>{
 const audio=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true},
   mediaPolicy:{policyVersion:'media-v2',analysisMode:'audio-only'}});
 const contract={schemaVersion:1,minimumReaderVersion:2,writersEnabled:true};
 db.seed('engineControl','mediaFleet',contract);
 await admitEnrichmentJob(db,{...request,clientCapabilities:['mediaRecoveryV1']},{features:audio});
 expect(db.read('enrichmentJobs','new')).toMatchObject({status:'failed',failure:{code:'dependency_error'}});
 db.seed('engineControl','mediaFleet',{...contract,minimumMediaPolicyVersion:2});
 await admitEnrichmentJob(db,{...request,jobId:'compatible',clientCapabilities:['mediaRecoveryV1']},{features:audio});
 expect(db.read('enrichmentJobs','compatible')).toMatchObject({status:'pending',engineQueued:true,
   engineFeatures:{media:{policy:{policyVersion:'media-v2',analysisMode:'audio-only'}}}});
 // A settings change must not revive the already rejected receipt.
 const replay=await admitEnrichmentJob(db,{...request,clientCapabilities:['mediaRecoveryV1']},{features:audio});
 expect(replay.body.status).toBe('failed');
 expect(db.read('enrichmentJobs','new').engineQueued).not.toBe(true);
});
