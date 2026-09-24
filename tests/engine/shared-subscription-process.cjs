// IPC-backed transactional test datastore. No sockets, credentials or providers.
const {createSharedAiOperations}=require('../../lib/sharedAiOperation');
const jobContext=require('../../lib/jobContext');
const {EngineError}=require('../../lib/engineError');
const {withMediaContext}=require('../../lib/media/mediaContext');
let next=0, release;
const calls=new Map(), hold=new Promise(resolve=>{release=resolve;});
function rpc(method,args={}) {
  return new Promise((resolve,reject)=>{const id=++next;calls.set(id,{resolve,reject});process.send({rpc:true,id,method,...args});});
}
const snapshot=data=>({exists:data!==null,data:()=>data||undefined});
const db={collection:name=>({doc:id=>({path:`${name}/${id}`,get:async()=>snapshot(await rpc('get',{path:`${name}/${id}`}))})}),
  async runTransaction(work) {
    const transaction=await rpc('begin');const writes=[];
    try {
      const result=await work({get:async ref=>snapshot(await rpc('get',{path:ref.path,transaction})),
        set:(ref,data)=>writes.push({path:ref.path,data})});
      await rpc('commit',{transaction,writes});return result;
    } catch(error) {await rpc('rollback',{transaction});throw error;}
  }};
const coordinator=createSharedAiOperations({firestore:db,limits:{pollMs:10,subscriptionLeaseMs:500}});
const controller=new AbortController();
let started=false,authority=true;
process.on('message',message=>{
  if(message.response) {
    const pending=calls.get(message.id);if(!pending)return;calls.delete(message.id);
    if(message.error)pending.reject(Error(message.error));else pending.resolve(message.value);
    return;
  }
  if(message.command==='cancel')controller.abort();
  if(message.command==='invalidate'){authority=false;process.send({event:'invalidated'});}
  if(message.command==='release')release();
  if(message.command==='stop')process.exit(0);
  if(message.command==='start'&&!started) {
    started=true;
    const config={kind:message.media ? 'asr_chunk' : 'process-subscription',input:{run:message.run},scope:'user:synthetic',model:'stub',promptVersion:1,schemaVersion:1,optionsVersion:1,
      timeoutMs:5000,signal:controller.signal,validate:value=>value?.answer==='venue'};
    const invoke=()=>coordinator.runSharedAiOperation(config,async({sharedOperation})=>{
      process.send({event:'entered'});await hold;
      await sharedOperation.authorizeDispatch();process.send({event:'physical-call'});
      return {answer:'venue'};
    });
    jobContext.run({signal:controller.signal,deadline:Date.now()+10000,
      validateProviderDispatch:async()=>{if(!authority)throw new EngineError('attempt_stopped');}},
    ()=>message.media ? withMediaContext(invoke,{maxDurationMs:5000,reserveMs:1000}) : invoke())
      .then(value=>process.send({event:'result',value}),error=>process.send({event:'failure',code:error.code}));
  }
});
process.on('disconnect',()=>process.exit(0));
process.send({event:'ready'});
