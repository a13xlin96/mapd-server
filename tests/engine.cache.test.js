jest.mock('@upstash/redis',()=>({Redis:jest.fn()}));
const {getCached,setCache,normalizeUrlForCache}=require('../lib/cache');
test('memory fallback honors per-entry TTL',async()=>{
  const now=jest.spyOn(Date,'now').mockReturnValue(100000);
  await setCache('short-test',{ok:true},5);await setCache('long-test',{ok:true},20);
  now.mockReturnValue(106000);
  expect(await getCached('short-test')).toBeNull();expect(await getCached('long-test')).toEqual({ok:true});
  now.mockRestore();
});
test('Instagram tracking keys and query ordering do not fragment the cache',()=>{
  expect(normalizeUrlForCache('https://www.instagram.com/reel/ABC/?stkn=123&z=1&a=2')).toBe('https://www.instagram.com/reel/ABC?a=2&z=1');
});
