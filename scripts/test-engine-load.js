// Uses the real Upstash HTTP SDK against a local simulated Redis command
// service, plus two isolated Node processes. No social sites or paid APIs.
const http=require('http'),{fork}=require('child_process'),path=require('path'),assert=require('assert/strict');
const store=new Map();let active=0,peak=0,starts=0;
const read=key=>{const v=store.get(key);if(!v || v.expires<=Date.now()){store.delete(key);return null;}return v.value;};
function command(parts) {
  const [verb,...args]=parts;let result;
  switch(String(verb).toUpperCase()) {
    case 'GET':result=read(args[0]);break;
    case 'SET': {
      const [key,value,...options]=args;
      const words=options.map(v=>String(v).toUpperCase());
      if(words.includes('NX') && read(key)!==null) {result=null;break;}
      const index=words.indexOf('EX'),seconds=index<0?86400:Number(options[index+1]);
      store.set(key,{value,expires:Date.now()+seconds*1000});result='OK';break;
    }
    case 'EVAL': {
      const [_script,_count,key,owner]=args;
      result=read(key)===owner?1:0;if(result)store.delete(key);break;
    }
    default:throw new Error('Unexpected command '+verb);
  }
  return {result:typeof result==='string' && result!=='OK'?Buffer.from(result).toString('base64'):result};
}
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  try {
    const body=JSON.parse(raw);const payload=Array.isArray(body[0])?body.map(command):command(body);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(payload));
  } catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const start=Date.now();
  await Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{
    const child=fork(path.resolve(__dirname,'../tests/engine/provider-process.cjs'),[],{
      env:{...process.env,NODE_ENV:'test',UPSTASH_REDIS_REST_URL:`http://127.0.0.1:${address.port}`,UPSTASH_REDIS_REST_TOKEN:'synthetic-test-token'},stdio:['ignore','ignore','pipe','ipc'],
    });
    let error='';child.stderr.on('data',chunk=>{error+=chunk;});
    child.on('message',message=>{
      if(message.event==='start'){active++;starts++;peak=Math.max(peak,active);}
      if(message.event==='end')active--;
      if(message.event==='error')error+=message.message;
    });
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error || `Child exit ${code}`)));
  })));
  assert.equal(starts,10);assert.equal(peak,1);assert.equal(active,0);
  console.log(JSON.stringify({scope:'two processes, simulated Redis, stubbed provider',requests:starts,peakProviderConcurrency:peak,elapsedMs:Date.now()-start}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
