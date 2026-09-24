const {fork}=require('child_process');
const path=require('path');
const {randomUUID}=require('crypto');
const {FakeFirestore}=require('./helpers/fakeFirestore');
const {COLLECTION}=require('../lib/sharedAiStore');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test) {for(let n=0;n<500&&!test();n++)await wait(5);expect(test()).toBeTruthy();}

test.each([[false,false,false],[true,false,false],[false,true,false],[true,true,false],
  [false,false,true],[true,false,true],[false,true,true],[true,true,true]])(
  'real process membership: invalidate remote=%s; use authority hook=%s; media=%s',async(cancelRemote,authority,media)=>{
  const db=new FakeFirestore();db.strictReadOrder=true;
  const transactions=new Map();let transactionId=0;
  function spawn() {
    const child=fork(path.join(__dirname,'engine/shared-subscription-process.cjs'),[],{
      env:{PATH:process.env.PATH,NODE_ENV:'test'},stdio:['ignore','ignore','pipe','ipc']});
    const events=[];let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
    const reply=(id,value,error)=>{if(child.connected)child.send({response:true,id,value,error});};
    const ref=full=>{const i=full.lastIndexOf('/');return db.collection(full.slice(0,i)).doc(full.slice(i+1));};
    child.on('message',message=>{
      if(!message.rpc){events.push(message);return;}
      const {id,method}=message;
      if(method==='begin') {
        const token=++transactionId;
        db.runTransaction(async tx=>{
          const end=await new Promise(resolve=>{transactions.set(token,{tx,resolve});reply(id,token);});
          if(end.rollback)throw Object.assign(Error('rollback'),{reply:end});
          for(const write of end.writes)tx.set(ref(write.path),write.data);
          return end;
        }).then(end=>{transactions.delete(token);reply(end.id,true);},error=>{
          transactions.delete(token);if(error.reply)reply(error.reply.id,true);
          else reply(id,null,error.message);
        });
      } else if(method==='get') {
        const read=message.transaction?transactions.get(message.transaction).tx.get(ref(message.path)):ref(message.path).get();
        read.then(snap=>reply(id,snap.exists?snap.data():null),error=>reply(id,null,error.message));
      } else {
        const tx=transactions.get(message.transaction);
        if(tx)tx.resolve({id,writes:message.writes,rollback:method==='rollback'});
        else reply(id,true);
      }
    });
    return {child,events,errors:()=>errors,send:command=>child.send({command}),has:event=>events.some(item=>item.event===event)};
  }
  const leader=spawn(),follower=spawn(),children=[leader,follower],run=randomUUID();
  try {
    await until(()=>children.every(item=>item.has('ready')));
    leader.child.send({command:'start',run,media});await until(()=>leader.has('entered'));
    follower.child.send({command:'start',run,media});
    const running=()=>[...(db.collections.get(COLLECTION)||new Map()).values()].find(row=>row.state==='running');
    await until(()=>Object.keys(running()?.subscribers||{}).length===2);
    leader.send(authority?'invalidate':'cancel');
    await until(()=>leader.has(authority?'invalidated':'failure'));
    if(!authority)expect(leader.events.find(item=>item.event==='failure').code).toBe('attempt_stopped');
    await until(()=>Object.keys(running()?.subscribers||{}).length===1);
    // Let a remote heartbeat renew after the leader's local subscriber left.
    await wait(550);
    if(cancelRemote) {
      follower.send(authority?'invalidate':'cancel');await until(()=>follower.has(authority?'invalidated':'failure'));
      if(!authority)await until(()=>Object.keys(running()?.subscribers||{}).length===0);
    }
    leader.send('release');
    if(cancelRemote) {
      await until(()=>[...(db.collections.get(COLLECTION)||new Map()).values()].some(row=>row.state==='failed'));
      expect(children.flatMap(item=>item.events).filter(item=>item.event==='physical-call')).toHaveLength(0);
    } else {
      await until(()=>follower.has('result'));
      expect(follower.events.find(item=>item.event==='result').value).toEqual({answer:'venue'});
      expect(children.flatMap(item=>item.events).filter(item=>item.event==='physical-call')).toHaveLength(1);
    }
    for(const child of children)expect(child.errors()).toBe('');
  } finally {
    for(const tx of transactions.values())tx.resolve({rollback:true,id:0});
    for(const {child} of children)if(child.exitCode===null)child.kill();
    await Promise.all(children.map(({child})=>child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve()));
  }
},10000);
