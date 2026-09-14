jest.mock('../lib/firestore',()=>{
  const {getSharedFirestore,makeAdmin}=require('./helpers/fakeFirestore');
  return {firestore:getSharedFirestore(),admin:{...makeAdmin(),auth:()=>({verifyIdToken:async token=>({uid:token})})},seedFeatureFlagsPromise:Promise.resolve()};
});
jest.mock('../lib/enrichmentWorker',()=>({createWorker:()=>({nudge:jest.fn(),start:jest.fn()})}));
jest.mock('../lib/enrichmentSweeper',()=>({}));
jest.mock('../lib/admin',()=>({router:require('express').Router()}));
jest.mock('../lib/listMembership',()=>({router:require('express').Router()}));
jest.mock('../lib/interestProfile',()=>({interestProfileRouter:require('express').Router(),recordPinSaved:jest.fn(async()=>{})}));
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn()}));
jest.mock('../lib/anthropic',()=>({anthropic:{messages:{create:jest.fn()}}}));
jest.mock('../lib/thumbnails',()=>({persistThumbnail:jest.fn(async image=>image)}));
jest.mock('../lib/extraction',()=>({extractPublicPost:jest.fn(async()=>({title:'Cafe',description:'Cafe in Kyoto',thumbnail_url:''}))}));
const request=require('supertest');
const {app}=require('../index');
const {firestore:db}=require('../lib/firestore');
const {anthropic}=require('../lib/anthropic');
const engineAI=require('../enrich/ai');
const {extractPublicPost}=require('../lib/extraction');
const url='https://www.instagram.com/reel/TEST/';
beforeEach(()=>{db.reset();jest.clearAllMocks();});
afterEach(()=>jest.restoreAllMocks());
test.each(['/extract','/ai/extract-places','/ai/extract-place','/ai/verify-place','/ai/infer-place-regions','/ai/vision-extract','/enrich','/enrich/selection'])('shipped %s route rejects unauthenticated work',async route=>{
  expect((await request(app).post(route).send({url,jobId:'job',userId:'u'})).status).toBe(401);
  expect(anthropic.messages.create).not.toHaveBeenCalled();expect(extractPublicPost).not.toHaveBeenCalled();
});
test('shipped admission route persists work before returning and blocks UID forgery',async()=>{
  const body={url,jobId:'durable',userId:'u'};
  expect((await request(app).post('/enrich').set('Authorization','Bearer attacker').send(body)).status).toBe(403);
  expect(db.read('enrichmentJobs','durable')).toBeUndefined();
  expect((await request(app).post('/enrich').set('Authorization','Bearer u').send(body)).status).toBe(202);
  expect(db.read('enrichmentJobs','durable')).toMatchObject({status:'pending',engineQueued:true,userId:'u'});
  await db.collection('enrichmentJobs').doc('durable').update({status:'failed'});
  expect((await request(app).post('/enrich').set('Authorization','Bearer u').send(body)).body.status).toBe('failed');
});
test('compatibility AI route forces private scope even if caller asks for public',async()=>{
  const extract=jest.spyOn(engineAI,'aiExtractPlaces').mockResolvedValue({places:[],count:0});
  const body={description:'Private note',scope:'public'};
  const result=await request(app).post('/ai/extract-places').set('Authorization','Bearer u').send(body);
  expect(result.status).toBe(200);expect(extract).toHaveBeenCalledWith(body,{scope:'user:u'});
});
test('shipped selection route rejects another user without modifying the job',async()=>{
  db.seed('enrichmentJobs','selection',{userId:'u',url,status:'needs_selection',candidates:[]});
  const result=await request(app).post('/enrich/selection').set('Authorization','Bearer attacker').send({jobId:'selection',selectedPlaceIds:[]});
  expect(result.status).toBe(403);expect(db.read('enrichmentJobs','selection').status).toBe('needs_selection');
});
