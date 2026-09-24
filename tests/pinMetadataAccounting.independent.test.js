// Independent rollout/reordering review; changes only new test files.
const {FakeFirestore,FakeTimestamp,makeAdmin}=require('./helpers/fakeFirestore');
const {createPinAccounting}=require('../functions/lib/pinAccounting');
const {hash}=require('../functions/lib/contentIdentity');
const empty={exists:false,data:()=>undefined};
function setup() {
  const db=new FakeFirestore();let clock=10;db.setNow(()=>clock);db.strictReadOrder=true;
  db.seed('users','alice',{});
  db.seed('accountingControls','current',{captureEnabled:true,historyCoverageStart:FakeTimestamp.fromMillis(100)});
  clock=200;
  const accounting=createPinAccounting({db,admin:makeAdmin()});
  const ref=db.collection('pins').doc('p');
  const docs=()=>[...(db.collections.get('users/alice/interestProfile')||[])];
  const summary=()=>db.read('users/alice/interestProfile','currentMetadata');
  async function write(value) {
    const before=await ref.get();clock+=10;
    if(value===null) await ref.delete();else await ref.set(value);
    return {id:`e-${clock}`,time:new Date(clock).toISOString(),params:{pinId:'p'},data:{before,after:await ref.get()}};
  }
  const pin=(extra={})=>({userId:'alice',category:'food',city:'Kyoto',country:'JP',placeId:'synthetic',
    detailsSchemaVersion:1,detailsState:'complete',rating:4.5,notes:'PRIVATE_NOTE',url:'https://private.example/note',...extra});
  return {db,accounting,ref,docs,summary,write,pin};
}
const featureId=(dimension,value)=>`metadataFeature_${hash(JSON.stringify([dimension,value]))}`;

test.each([[0,1,2,3],[3,2,1,0],[2,0,3,1],[1,3,0,2]].map(order=>[order]))('duplicate/reversed delete-recreate sequence %j converges without extra saves',async order=>{
  const s=setup();
  const events=[await s.write(s.pin()),await s.write(s.pin({city:'Osaka',rating:4.8})),await s.write(null),await s.write(s.pin({city:'Taipei',country:'TW',category:'park'}))];
  await Promise.all(order.flatMap(i=>[s.accounting.onPinWritten(events[i]),s.accounting.onPinWritten(events[i])]));
  expect(s.summary()).toMatchObject({currentPins:1,knownDetailsPins:1});
  expect(s.db.read('users/alice/stats','current').currentPins).toBe(1);
  expect(s.db.read('users/alice/interestProfile','v2')).toMatchObject({verifiedPinSaves:2,lastPinCity:'Taipei'});
  const active=s.docs().filter(([id,data])=>id.startsWith('metadataPin_')&&data.exists);
  expect(active).toHaveLength(1);expect(active[0][1].geography.city).toBe('Taipei');
  expect(s.db.read('users/alice/interestProfile',featureId('city','Taipei')).currentPins).toBe(1);
  expect(JSON.stringify(s.docs())).not.toContain('PRIVATE_NOTE');expect(JSON.stringify(s.docs())).not.toContain('private.example');
});

test('deletion and delayed hydration after account deletion cannot recreate profile data',async()=>{
  const s=setup(), created=await s.write(s.pin());await s.accounting.onPinWritten(created);
  const late=await s.write(s.pin({city:'Osaka'}));
  const user=await s.db.collection('users').doc('alice').get();
  await s.db.collection('users').doc('alice').delete();
  await s.accounting.onUserDeleted({params:{userId:'alice'},data:user});
  const before=JSON.stringify(s.docs());
  const deleted=await s.write(null);
  await Promise.all([s.accounting.onPinWritten(late),s.accounting.onPinWritten(deleted),s.accounting.onPinWritten(created)]);
  expect(JSON.stringify(s.docs())).toBe(before);
  expect(s.db.read('users','alice')).toBeUndefined();
});

test('an older contribution writer during rollout must not double-count existing metadata',async()=>{
  const s=setup(), created=await s.write(s.pin());await s.accounting.onPinWritten(created);
  const head=s.accounting.refsFor('alice','p').contribution;
  const {metadataGeneration,...legacyHead}=(await head.get()).data();
  expect(metadataGeneration).toBeTruthy();
  // Before this patch, pinAccounting rewrites this whole document without
  // metadataGeneration on any changed source/visit contribution. A still-live
  // old function invocation can therefore erase the new pointer during rollout.
  await head.set(legacyHead);
  await s.accounting.reconcile({uid:'alice',pinId:'p'});
  expect(s.summary()).toMatchObject({currentPins:1,knownDetailsPins:1});
  expect(s.db.read('users/alice/interestProfile',featureId('city','Kyoto')).currentPins).toBe(1);
  expect(s.docs().filter(([id,v])=>id.startsWith('metadataPin_')&&v.exists)).toHaveLength(1);
});
