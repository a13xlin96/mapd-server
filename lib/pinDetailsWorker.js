'use strict';

const {COLLECTION,createPinDetails}=require('./pinDetails');
const listeners=new Set();
function notifyDetailWork(){for(const nudge of listeners)nudge();}

// One detail job per process; the existing provider slots still bound fleet
// Google concurrency. Fair FIFO discovery plus an idle backoff avoids a tight
// empty-queue read loop. No listener starts merely by importing the module.
function createPinDetailsWorker({db,admin,fetchDetails,now=Date.now}) {
  const service=db ? createPinDetails({db,admin,fetchDetails,now}) : null;
  let started=false, stopped=false, active=null, timer=null, idleMs=1000;
  function schedule(ms){if(!started || stopped || !service)return;clearTimeout(timer);timer=setTimeout(()=>{timer=null;tick().catch(()=>{});},ms);timer.unref?.();}
  async function tick(){
    if(!service || stopped)return;
    if(active)return active;
    active=(async()=>{
      let count=0;
      const expired=await db.collection(COLLECTION).where('status','==','running').where('deadline','<=',now()).limit(10).get();
      for(const doc of expired.docs){await service.expire(doc.id);count++;}
      const queued=await db.collection(COLLECTION).where('status','==','queued').orderBy('createdAt','asc').limit(1).get();
      if(!stopped && queued.docs.length){await service.process(queued.docs[0].id);count++;}
      idleMs=count ? 1000 : Math.min(30000,idleMs*2);
    })().catch(error=>{idleMs=Math.min(30000,idleMs*2);console.warn('Place details worker unavailable:',error.code || 'dependency_error');})
      .finally(()=>{active=null;schedule(idleMs);});
    return active;
  }
  function nudge(){idleMs=1000;if(!active)schedule(0);}
  function start(){if(started || !service)return;started=true;stopped=false;listeners.add(nudge);schedule(0);}
  async function stop(){stopped=true;started=false;listeners.delete(nudge);clearTimeout(timer);await active;}
  return {start,stop,nudge,tick,retry:async(...args)=>{if(!service)throw new Error('Details unavailable');const result=await service.retry(...args);nudge();return result;}};
}
module.exports={createPinDetailsWorker,notifyDetailWork};
