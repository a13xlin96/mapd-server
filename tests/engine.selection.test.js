jest.mock('../lib/firestore',()=>{
  const {getSharedFirestore,makeAdmin}=require('./helpers/fakeFirestore');return {firestore:getSharedFirestore(),admin:makeAdmin()};
});
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn()}));
jest.mock('../lib/interestProfile',()=>({recordPinSaved:jest.fn(async()=>{})}));
const {firestore:db}=require('../lib/firestore');
const {saveSelectedPlaces}=require('../enrich');
const {recordPinSaved}=require('../lib/interestProfile');
const url='https://www.instagram.com/reel/TEST/';
const pin=id=>({placeId:id,placeName:id,userId:'u',url,ogTitle:'Dinner',ogImage:'',sourceApp:'instagram',sourceDomain:'instagram.com',category:'restaurant',city:'Kyoto',country:'Japan',latitude:35,longitude:135});
beforeEach(()=>{db.reset();jest.clearAllMocks();});
test('selection saves multiple places from one source and leaves unresolved places retryable',async()=>{
  db.seed('enrichmentJobs','select',{userId:'u',url,status:'needs_selection',candidates:[pin('one'),pin('two')],outcomes:[{name:'one',placeId:'one',status:'candidate'},{name:'two',placeId:'two',status:'candidate'},{name:'three',status:'unresolved'}]});
  const result=await saveSelectedPlaces('select','u',['one','two']);
  expect(result.failure.code).toBe('partial_save');expect(result.progress).toEqual({saved:2,total:3});
  expect((await db.collection('pins').get()).docs).toHaveLength(2);expect(recordPinSaved).toHaveBeenCalledTimes(2);
  await saveSelectedPlaces('select','u',['one','two']);expect(recordPinSaved).toHaveBeenCalledTimes(2);
});
test('another user and an invented candidate cannot use a selection job',async()=>{
  db.seed('enrichmentJobs','select',{userId:'u',url,status:'needs_selection',candidates:[pin('one')]});
  await expect(saveSelectedPlaces('select','attacker',['one'])).rejects.toMatchObject({code:'access_blocked'});
  await expect(saveSelectedPlaces('select','u',['invented'])).rejects.toMatchObject({code:'invalid_response'});
  expect(db.read('enrichmentJobs','select').status).toBe('needs_selection');expect((await db.collection('pins').get()).docs).toHaveLength(0);
});

test('a revoked worker cannot commit a pin or attach a source',async()=>{
  const {writePinTransactional,appendSourceToExistingPin}=require('../enrich');
  const context=require('../lib/jobContext');
  db.seed('enrichmentJobs','stopped',{userId:'u',status:'failed',workerOwner:'old'});
  db.seed('pins','existing',pin('one'));
  await context.run({jobId:'stopped',leaseOwner:'old',deadline:Date.now()+60000},async()=>{
    await expect(writePinTransactional(pin('two'),{})).rejects.toMatchObject({code:'attempt_stopped'});
    await expect(appendSourceToExistingPin('existing',{url:'https://example.com/new'})).rejects.toMatchObject({code:'attempt_stopped'});
  });
  expect((await db.collection('pins').get()).docs).toHaveLength(1);
  expect(db.read('pins','existing').sources).toBeUndefined();
});

test('all selected saves stay complete with separate analysis recovery; dismiss does not revive it',async()=>{
 const recovery={version:1,status:'incomplete',reason:'media_incomplete',canRetry:true};
 db.seed('enrichmentJobs','select',{userId:'u',url,status:'needs_selection',analysisRecovery:recovery,candidates:[pin('one'),pin('two')],outcomes:[{name:'one',placeId:'one',status:'candidate'},{name:'two',placeId:'two',status:'candidate'}]});
 const result=await saveSelectedPlaces('select','u',['one']);
 expect(result).toMatchObject({status:'complete',progress:{saved:1,total:1},analysisRecovery:recovery});
 expect(result.outcomes.find(o=>o.placeId==='two').status).toBe('dismissed');
 db.seed('enrichmentJobs','dismiss',{userId:'u',url,status:'needs_selection',analysisRecovery:recovery,candidates:[pin('two')],outcomes:[{name:'two',placeId:'two',status:'candidate'}]});
 expect(await saveSelectedPlaces('dismiss','u',[])).toMatchObject({status:'complete',analysisRecovery:null});
});
