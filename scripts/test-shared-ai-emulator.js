'use strict';
// Real independent processes and Firestore transactions; the provider is a
// counter plus a delay. Refuses all non-local projects and never loads API keys.
const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const admin=require('firebase-admin');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const projectId=process.env.GCLOUD_PROJECT;
if(!['demo-mapd-engine','demo-mapd-details-review'].includes(projectId) || !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Dedicated local demo-mapd-engine Firestore emulator required');
}
const app=admin.initializeApp({projectId},`shared-ai-${process.pid}`), db=app.firestore();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function child() {
  const runId=process.argv[3], scope=process.argv[4];
  const coordinator=createSharedAiOperations({firestore:db});
  const options={kind:'emulator',input:{runId},scope:scope==='public'?SERVER_PUBLIC_SCOPE:`user:${scope}`,
    model:'stub',promptVersion:'1',schemaVersion:1,optionsVersion:'1',timeoutMs:20000,validate:v=>v.answer==='stubbed venue'};
  process.send({event:'ready'});
  await new Promise(resolve=>process.once('message',resolve));
  const result=await Promise.all([1,2,3].map(()=>coordinator.runSharedAiOperation(options,async({sharedOperation})=>{
    await sharedOperation.authorizeDispatch({reservationId:'synthetic-observation'});
    await db.collection('testProviderCalls').doc(runId).set({calls:admin.firestore.FieldValue.increment(1)},{merge:true});
    await sleep(350);
    return {answer:'stubbed venue'};
  })));
  assert.equal(result.length,3);
  process.send({event:'done'});
}
async function wave(runId,scopes) {
  const children=scopes.map(scope=>fork(__filename,['--child',runId,scope],{
    env:{PATH:process.env.PATH,NODE_ENV:'test',GCLOUD_PROJECT:projectId,FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST},
    stdio:['ignore','ignore','pipe','ipc'],
  }));
  try {
    let ready=0;
    await Promise.all(children.map(proc=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Child deadline')),30000); let done=false, diagnostics='';
      proc.stderr.on('data',chunk=>{diagnostics+=chunk;});
      proc.on('error',error=>{clearTimeout(timer);reject(error);});
      proc.on('message',message=>{
        if(message.event==='ready' && ++ready===children.length)for(const child of children)child.send('start');
        if(message.event==='done')done=true;
      });
      proc.on('exit',code=>{clearTimeout(timer);code===0&&done?resolve():reject(new Error(diagnostics || `Child failed ${code}`));});
    })));
  } finally {for(const child of children)if(child.exitCode===null)child.kill();}
}
async function main() {
  const runId=randomUUID();
  await wave(runId,['public','public']);
  assert.equal((await db.collection('testProviderCalls').doc(runId).get()).get('calls'),1);
  await wave(runId,['public']);
  assert.equal((await db.collection('testProviderCalls').doc(runId).get()).get('calls'),1);
  await wave(runId,['alice','bob']);
  assert.equal((await db.collection('testProviderCalls').doc(runId).get()).get('calls'),3);
  console.log(JSON.stringify({scope:'real local Firestore, independent processes, stubbed provider',publicCallers:9,publicPhysicalCalls:1,privatePhysicalCalls:2}));
}
(process.argv[2]==='--child'?child():main()).catch(error=>{console.error(error);process.exitCode=1;})
  .finally(async()=>{await app.delete();if(process.send)process.disconnect();});
