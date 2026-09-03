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

  // POST /lists/join lives in the listMembership router (mounted via
  // app.use, not app.post here in index.js), so it can't carry apiLimiter
  // inline the way the routes above do. It's rate-limited via a
  // path-scoped `app.use('/lists/join', apiLimiter)` registered ahead of
  // the router mount instead — this amends the S2 plan's "router-mounted
  // routes don't get limiters" note for this one route, since it's the
  // only listMembership route keyed on a guessable secret (the invite
  // token) rather than a listId/pinId the caller must already know.
  test('/lists/join is rate-limited via a path-scoped apiLimiter mounted before the listMembership router', () => {
    const limiterIdx = src.search(/app\.use\('\/lists\/join',\s*apiLimiter\)/);
    const routerMountIdx = src.indexOf('app.use(listMembershipRouter)');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(routerMountIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(routerMountIdx);
  });

  // S3 pins-privacy-lockdown Task 2: GET /lists/:listId/pins gets its own
  // path-scoped limiter, mounted before the router the same way
  // /lists/join's is, rather than folding into a single
  // `app.use('/lists', apiLimiter)` that would also start limiting the
  // deliberately-unlimited remove/overrides routes on the same router.
  test('/lists/:listId/pins is rate-limited via a path-scoped apiLimiter mounted before the listMembership router', () => {
    const limiterIdx = src.search(/app\.use\('\/lists\/:listId\/pins',\s*apiLimiter\)/);
    const routerMountIdx = src.indexOf('app.use(listMembershipRouter)');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(routerMountIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(routerMountIdx);
  });

  // visitedBy-chips restoration: GET /lists/:listId/visits gets the same
  // path-scoped-limiter treatment as /lists/:listId/pins, for the same
  // reason (readable with just a listId the caller may not otherwise
  // have a relationship to).
  test('/lists/:listId/visits is rate-limited via a path-scoped apiLimiter mounted before the listMembership router', () => {
    const limiterIdx = src.search(/app\.use\('\/lists\/:listId\/visits',\s*apiLimiter\)/);
    const routerMountIdx = src.indexOf('app.use(listMembershipRouter)');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(routerMountIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(routerMountIdx);
  });

  // S5 interest-profile-server-side plan, Task 1: POST /interest-profile/pin-saved
  // lives in its own router (mounted via app.use, like listMembershipRouter),
  // so — same as /lists/join — it gets a path-scoped `app.use('/interest-profile',
  // apiLimiter)` registered ahead of the router mount instead of an inline
  // apiLimiter arg.
  test('/interest-profile is rate-limited via a path-scoped apiLimiter mounted before the interestProfileRouter', () => {
    const limiterIdx = src.search(/app\.use\('\/interest-profile',\s*apiLimiter\)/);
    const routerMountIdx = src.indexOf('app.use(interestProfileRouter)');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(routerMountIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(routerMountIdx);
  });

  test('open CORS is removed', () => {
    expect(src).not.toMatch(/app\.use\(cors\(\)\)/);
  });

  test('trust proxy is set for correct client IPs behind Render', () => {
    expect(src).toMatch(/app\.set\('trust proxy', 1\)/);
  });
});
