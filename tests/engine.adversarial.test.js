jest.mock('../lib/firestore',()=>{
  const {getSharedFirestore,makeAdmin}=require('./helpers/fakeFirestore');return {firestore:getSharedFirestore(),admin:makeAdmin()};
});
jest.mock('axios',()=>({get:jest.fn(async()=>({data:'<meta property="og:description" content="A place">',status:200,headers:{}}))}));
const {firestore:db}=require('../lib/firestore');
const {FakeTimestamp}=require('./helpers/fakeFirestore');
const {getRetryContext}=require('../lib/retryContext');
const {rankPlaces}=require('../enrich/confidence');
const {fetchOGMetadata}=require('../enrich/ogMetadata');
const {createWorker}=require('../lib/enrichmentWorker');
const axios=require('axios');
beforeEach(()=>{db.reset();jest.clearAllMocks();});
test('country conflict cannot be overruled by an exact business name',()=>{
  const candidate={place_id:'wrong',name:'Tai Sushi',formatted_address:'Miami, Florida, USA',geometry:{location:{lat:25,lng:-80}}};
  expect(rankPlaces([candidate],{}, {name:'Tai Sushi',country:'Japan'}).place).toBeNull();
});
test('a crash after the first selected pin commit resumes only missing selected places',async()=>{
  const url='https://www.instagram.com/reel/TEST/';
  db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['one','two'],outcomes:[
    {name:'one',placeId:'one',status:'candidate'}, {name:'two',placeId:'two',status:'candidate'}, {name:'not chosen',placeId:'three',status:'candidate'},
  ]});
  db.seed('pins','saved',{userId:'u',placeId:'one'});
  db.seed('enrichmentJobs','child',{userId:'u',url,status:'processing',retryOf:'parent'});
  const retry=await getRetryContext(db,'child','u',url);
  expect(retry.resumePlaces?.map(p=>p.name)).toEqual(['two']);
  expect(retry.baseOutcomes).toEqual([expect.objectContaining({name:'one',status:'existing',pinId:'saved'})]);
});
test('generic metadata cannot fetch the loopback interface',async()=>{
  await expect(fetchOGMetadata('https://127.0.0.1/internal')).rejects.toMatchObject({code:'access_blocked'});
  expect(axios.get).not.toHaveBeenCalled();
});
test('an obsolete queued flag on a terminal job cannot occupy the worker scan forever',async()=>{
  db.seed('enrichmentJobs','zombie',{userId:'u',status:'complete',engineQueued:true,queueDeadline:FakeTimestamp.fromMillis(Date.now()+30000)});
  const run=jest.fn(),worker=createWorker({db,runEnrichment:run});
  await worker.tick();await worker.idle();
  expect(db.read('enrichmentJobs','zombie').engineQueued).toBe(false);expect(run).not.toHaveBeenCalled();
});

test('a tag-only candidate mislabeled by AI cannot bypass confirmation',()=>{
  const candidate={place_id:'restaurant',name:'Tai Sushi',formatted_address:'Kyoto, Japan',geometry:{location:{lat:35,lng:135}}};
  const evidence={description:'Dinner with @tai.sushi in Kyoto',accountTags:[{handle:'tai.sushi',displayName:'Tai Sushi',origin:'post_tag'}]};
  expect(rankPlaces([candidate],evidence,{name:'Tai Sushi',city:'Kyoto',source:'caption'}).requiresSelection).toBe(true);
});
test('malformed structured tags keep readable caption evidence',()=>{
  const {parseInstagramPost}=require('../lib/postMetadata');
  const html='<meta property="og:description" content="Dinner @tai.sushi"><script>'+JSON.stringify({shortcode:'TEST',edge_media_to_caption:{edges:{}},edge_media_to_tagged_user:{edges:{}},coauthor_producers:{}})+'</script>';
  expect(parseInstagramPost(html,'TEST').accountTags).toEqual([expect.objectContaining({handle:'tai.sushi',origin:'caption'})]);
});
