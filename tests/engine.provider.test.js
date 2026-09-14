jest.mock('../lib/cache',()=>({redis:null}));
const {withProvider,withLease}=require('../lib/providerRuntime');
test('same provider runs only one request at a time, even for different posts',async()=>{
  let active=0,peak=0;
  const calls=Array.from({length:8},()=>withProvider('synthetic',async()=>{
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return 'ok';
  }));
  await Promise.all(calls);expect(peak).toBe(1);
});
test('cooldown does not execute a new request, and its expiry starts nothing',async()=>{
  const work=jest.fn(async()=>{throw Object.assign(new Error('rate limit'),{status:429,retryAfter:'60'});});
  await expect(withProvider('limited',work)).rejects.toMatchObject({code:'rate_limited'});
  const next=jest.fn();await expect(withProvider('limited',next)).rejects.toMatchObject({code:'rate_limited'});
  expect(next).not.toHaveBeenCalled();expect(work).toHaveBeenCalledTimes(1);
});
test('no production coordination means no uncached work unless single-process is explicit',async()=>{
  const env=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try {await expect(withLease('blocked',async()=>{throw new Error('should not run');})).rejects.toMatchObject({stage:'coordination'});}
  finally{process.env.NODE_ENV=env;}
});
