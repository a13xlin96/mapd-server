const {withProvider}=require('../../lib/providerRuntime');
(async()=>{
  await Promise.all(Array.from({length:5},()=>withProvider('synthetic-burst',async()=>{
    process.send({event:'start'});await new Promise(r=>setTimeout(r,35));process.send({event:'end'});
  })));
  process.send({event:'done'});process.disconnect();
})().catch(error=>{process.send({event:'error',message:error.message});process.exitCode=1;process.disconnect();});
