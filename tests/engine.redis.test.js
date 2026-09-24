const mockRedis={get:jest.fn(),set:jest.fn(),eval:jest.fn()};
jest.mock('../lib/cache',()=>({redis:mockRedis}));
const {withProvider,withLease}=require('../lib/providerRuntime');
beforeEach(()=>{jest.clearAllMocks();mockRedis.get.mockResolvedValue(null);mockRedis.set.mockResolvedValue('OK');});
test('Redis read outage starts no provider work',async()=>{
  mockRedis.get.mockRejectedValue(new Error('Redis unavailable'));
  const work=jest.fn();
  await expect(withProvider('instagram',work)).rejects.toMatchObject({provider:'redis'});
  expect(work).not.toHaveBeenCalled();
});
test('Redis admission outage starts no work or local bypass',async()=>{
  mockRedis.set.mockRejectedValue(new Error('Redis unavailable'));
  const work=jest.fn();
  await expect(withLease('content',work)).rejects.toMatchObject({provider:'redis'});
  expect(work).not.toHaveBeenCalled();
});
test('lost lease cannot return a stale result or delete the new owner',async()=>{
  mockRedis.get.mockResolvedValue('new-owner');
  await expect(withLease('content',async()=>'stale')).rejects.toMatchObject({code:'attempt_stopped'});
  const [script,keys,args]=mockRedis.eval.mock.calls[0];
  expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
  expect(keys).toEqual(['engine:lease:content:0']);expect(args[0]).not.toBe('new-owner');
});
