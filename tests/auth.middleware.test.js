const { authenticateRequest } = require('../lib/auth');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('authenticateRequest', () => {
  test('rejects requests with no Authorization header', async () => {
    const req = { headers: {}, body: {} };
    const res = mockRes();
    const next = jest.fn();
    await authenticateRequest(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a malformed Bearer token', async () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' }, body: {} };
    const res = mockRes();
    const next = jest.fn();
    await authenticateRequest(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('admin path fails closed when ENRICH_ADMIN_TOKEN unset', async () => {
    delete process.env.ENRICH_ADMIN_TOKEN;
    const req = { headers: { 'x-admin-token': 'anything' }, body: { userId: 'u1' } };
    const res = mockRes();
    const next = jest.fn();
    await authenticateRequest(req, res, next);
    expect(res.statusCode).toBe(503);
  });
});
