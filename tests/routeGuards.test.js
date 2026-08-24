// tests/routeGuards.test.js — every AI/extract route must carry the
// rate limiter + auth middleware. Reads index.js source rather than booting
// the app, mirroring how enrich.adminPath.test.js avoids a full server boot.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

describe('route guards', () => {
  test.each([
    '/extract', '/ai/extract-places', '/ai/extract-place',
    '/ai/verify-place', '/ai/infer-place-regions', '/enrich',
  ])('%s is registered with apiLimiter + authenticateRequest', (route) => {
    const re = new RegExp(
      `app\\.post\\('${route.replace(/[/]/g, '\\/')}',\\s*apiLimiter,\\s*authenticateRequest`
    );
    expect(src).toMatch(re);
  });

  test('/ai/vision-extract carries apiLimiter + visionLimiter + authenticateRequest', () => {
    expect(src).toMatch(
      /app\.post\('\/ai\/vision-extract',\s*apiLimiter,\s*visionLimiter,\s*authenticateRequest/
    );
  });

  test('open CORS is removed', () => {
    expect(src).not.toMatch(/app\.use\(cors\(\)\)/);
  });

  test('trust proxy is set for correct client IPs behind Render', () => {
    expect(src).toMatch(/app\.set\('trust proxy', 1\)/);
  });
});
