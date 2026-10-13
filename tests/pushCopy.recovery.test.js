const mockSend=jest.fn(async()=>[{status:'ok'}]);
jest.mock('expo-server-sdk',()=>({Expo:class {
  static isExpoPushToken(){return true;}
  sendPushNotificationsAsync(messages){return mockSend(messages);}
}}));
jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
const {firestore:db}=require('../lib/firestore');
const {sendPushForJob}=require('../lib/push');
const {RECOVERY}=require('../lib/media/analysisRecovery');
beforeEach(()=>{db.reset();jest.clearAllMocks();db.seed('users','u',{expoPushToken:'synthetic-token'});});
test.each(['caption','media'])('%s recovery acknowledges saved places and opens Activity, even if caller reports failed',async kind=>{
 db.seed('enrichmentJobs','job',{status:'complete',progress:{saved:1,total:1},failure:null,
   analysisRecovery:RECOVERY,[`${kind}AnalysisIncomplete`]:true});
 await sendPushForJob('job','u','failed');
 expect(mockSend).toHaveBeenCalledWith([expect.objectContaining({title:'1 place saved',
   body:"Couldn't finish checking this post. Your saved places are kept. Tap to review.",data:{type:'pin_failed',jobId:'job'}})]);
 expect(db.read('enrichmentJobs','job').pushDelivery).toMatchObject({status:'sent',attempts:1});
});
test('duplicate with unfinished analysis reports multiple saved places',async()=>{
 db.seed('enrichmentJobs','job',{status:'duplicate',progress:{saved:3,total:3},analysisRecovery:RECOVERY});
 await sendPushForJob('job','u','duplicate');
 expect(mockSend.mock.calls[0][0][0]).toMatchObject({title:'3 places saved',data:{type:'pin_failed'}});
});
test('partial save takes priority over separate incomplete analysis',async()=>{
 db.seed('enrichmentJobs','job',{status:'failed',progress:{saved:1,total:2},analysisRecovery:RECOVERY,
   failure:{code:'partial_save',message:'1 of 2 places saved. Tap to finish saving.'}});
 await sendPushForJob('job','u','complete');
 expect(mockSend.mock.calls[0][0][0]).toMatchObject({title:'Some places saved',
   body:'1 of 2 places saved. Tap to finish saving.',data:{type:'pin_failed'}});
});
test('genuine failed save keeps failure copy and never claims any pin was saved',async()=>{
 db.seed('enrichmentJobs','job',{status:'failed',progress:{saved:0,total:1},analysisRecovery:RECOVERY,
   failure:{code:'dependency_error',message:'Unable to save. Tap Retry.'}});
 await sendPushForJob('job','u','complete');
 expect(mockSend.mock.calls[0][0][0]).toMatchObject({title:"Couldn't save this link",body:'Unable to save. Tap Retry.',data:{type:'pin_failed'}});
});
test('fully completed result uses saved copy despite stale failure hint',async()=>{
 db.seed('enrichmentJobs','job',{status:'complete',progress:{saved:1,total:1},analysisRecovery:null,failure:null});
 await sendPushForJob('job','u','failed',{pinId:'p',placeName:'Venue'});
 expect(mockSend.mock.calls[0][0][0]).toMatchObject({title:'📍 Pin saved!',body:'Venue added to your map',data:{type:'pin_saved',pinId:'p'}});
});
test('selection result stays actionable rather than declaring a saved or failed pin',async()=>{
 db.seed('enrichmentJobs','job',{status:'needs_selection',analysisRecovery:RECOVERY});
 await sendPushForJob('job','u','failed');
 expect(mockSend.mock.calls[0][0][0]).toMatchObject({title:'Multiple places found',data:{type:'pin_needs_selection'}});
});
