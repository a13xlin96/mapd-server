// tests/routeGuards.test.js — every AI/extract route must carry the
// rate limiter + auth middleware. Uses static regex matching against
// index.js's source rather than booting the real app and firing requests
// at it. This is a different (lighter) strategy than enrich.adminPath.test.js:
// that suite builds its own minimal Express app + supertest to exercise
// authenticateRequest through real HTTP requests, sidestepping only
// index.js's module-load side effects (app.listen(), the sweeper boot).
// Here we skip real requests entirely and just check route-registration
// order in the source, which is enough to catch a missing middleware.
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
