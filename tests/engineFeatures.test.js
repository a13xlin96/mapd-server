'use strict';
const { createEngineFeatures, FEATURE_VERSIONS } = require('../lib/engineFeatures');
const allFlags = Object.fromEntries(Object.keys(FEATURE_VERSIONS).filter(key => !['queuePolicy','selectionContract'].includes(key)).map(key => [key, true]));

test('missing config keeps optional behavior off and emergency admission separate', () => {
  const controller = createEngineFeatures();
  const snapshot = controller.selectForVerifiedUid('verified-user');
  expect(snapshot.versions).toEqual({...Object.fromEntries(Object.keys(FEATURE_VERSIONS).map(key=>[key,'legacy'])),selectionContract:'selection-v2'});
  expect(controller.admission.stopNewJobs).toBe(false);
  expect(snapshot).not.toHaveProperty('admission');
  expect(snapshot).not.toHaveProperty('uid');
});

test('internal accounts require explicit flags; language stays off independently', () => {
  const controller = createEngineFeatures({ internalUids: ['staff'], flags: { contentIndexReader: true } });
  expect(controller.selectForVerifiedUid('staff')).toMatchObject({ cohort: 'internal', versions: { contentIndexReader: 'content-index-v1', languageRouting: 'legacy' } });
  expect(controller.selectForVerifiedUid('customer').versions.contentIndexReader).toBe('legacy');
});

test('5% is deterministic and nested in 25% and 100% across config versions', () => {
  const controllers = [5, 25, 100].map(rolloutPercent => createEngineFeatures({ rolloutPercent, version: `release-${rolloutPercent}`, flags: allFlags }));
  let count = 0;
  for (let i = 0; i < 2000; i++) {
    const uid = `verified-${i}`;
    const selected = controllers.map(controller => controller.selectForVerifiedUid(uid).cohort === 'rollout');
    if (selected[0]) { count++; expect(selected[1]).toBe(true); }
    expect(selected[2]).toBe(true);
    expect(controllers[0].selectForVerifiedUid(uid)).toEqual(controllers[0].selectForVerifiedUid(uid));
  }
  expect(count).toBeGreaterThan(60);
  expect(count).toBeLessThan(140);
});

test('rollback and kill admission preserve the previously recorded job versions', () => {
  const snapshot = createEngineFeatures({ version: 'enabled', rolloutPercent: 100, flags: allFlags }).forJob('owner');
  const stored = JSON.parse(JSON.stringify(snapshot));
  const rollback = createEngineFeatures({ admission: { stopNewJobs: true } });
  expect(rollback.admission.stopNewJobs).toBe(true);
  const resumed = rollback.forJob('owner', stored);
  expect(resumed).toEqual(snapshot);
  expect(resumed).not.toBe(stored);
  expect(() => { resumed.versions.queuePolicy = 'fair-queue-v1'; }).toThrow();
  expect(() => { resumed.cohort = 'control'; }).toThrow();
  expect(rollback.forJob('owner').versions).toEqual({...Object.fromEntries(Object.keys(FEATURE_VERSIONS).map(key=>[key,'legacy'])),selectionContract:'selection-v2'});
});

test('pre-contract queued jobs stay legacy at execution even during a full rollout', () => {
  const controller = createEngineFeatures({ rolloutPercent: 100, flags: allFlags });
  expect(controller.forExecution().configVersion).toBe('legacy-unrecorded');
  expect(Object.values(controller.forExecution().versions).every(value => value === 'legacy')).toBe(true);
  const assigned = controller.forJob('verified-owner');
  expect(createEngineFeatures().forExecution(assigned)).toEqual(assigned);
  expect(() => controller.forExecution(null)).toThrow('recorded engine features');
});

test('external config mutation cannot change a controller', () => {
  const config = { internalUids: ['staff'], flags: { projectionReader: true }, admission: { stopNewJobs: true } };
  const controller = createEngineFeatures(config);
  config.internalUids.push('attacker'); config.flags.projectionReader = false; config.admission.stopNewJobs = false;
  expect(controller.selectForVerifiedUid('attacker').cohort).toBe('control');
  expect(controller.selectForVerifiedUid('staff').versions.projectionReader).toBe('projection-v2');
  expect(controller.admission.stopNewJobs).toBe(true);
});

test.each([undefined, null, '', {}, { uid: 'staff', body: { cohort: 'internal' } }, 'a'.repeat(129)])('rejects unverified/malformed UID input %p', uid => {
  expect(() => createEngineFeatures().forJob(uid)).toThrow('verified UID');
});

test('request fields are not an input to cohort selection', () => {
  const controller = createEngineFeatures({ internalUids: ['staff'], flags: allFlags });
  // The integration supplies auth.uid as the first argument; body has no API slot.
  expect(controller.selectForVerifiedUid('customer', { userId: 'staff', cohort: 'internal', flags: allFlags }).cohort).toBe('control');
});

test.each([null, { rolloutPercent: 6 }, { rolloutPercent: '100' }, { flags: { languageRouting: 'true' } }, { flags: { capture: false } }, { admission: { stopNewJobs: 'false' } }, { stopNewJobs: true }, { internalUids: [{}] }])('invalid server configuration fails closed %p', config => {
  expect(() => createEngineFeatures(config)).toThrow();
});

test.each([null, {}, { schemaVersion: 99 }, { ...createEngineFeatures().forJob('owner'), versions: { ...FEATURE_VERSIONS, queuePolicy: 'future' } }])('never reassigns malformed or future recorded snapshots %p', stored => {
  expect(() => createEngineFeatures().forJob('owner', stored)).toThrow('recorded engine features');
});


test('queue policy is a fleet assignment independent of account cohorts; old account flag is rejected', () => {
  const controller = createEngineFeatures({ internalUids: ['staff'] }, { queuePolicy: 'fair-queue-v1' });
  for (const uid of ['staff', 'control']) expect(controller.forJob(uid).versions.queuePolicy).toBe('fair-queue-v1');
  expect(() => createEngineFeatures({ flags: { queuePolicy: true } })).toThrow();
  const stored = controller.forJob('control');
  expect(createEngineFeatures().forExecution(stored)).toEqual(stored);
});

test('new jobs declare the existing v2 selection capability for every account; recovery cannot be downgraded by a cohort toggle', () => {
  const controller=createEngineFeatures({internalUids:['staff']});
  for(const uid of ['staff','customer']) expect(controller.forJob(uid).versions.selectionContract).toBe('selection-v2');
  expect(() => createEngineFeatures({flags:{selectionContract:false}})).toThrow();
  // Truly old jobs retain their recorded protocol for compatibility handling.
  expect(controller.forExecution().versions.selectionContract).toBe('legacy');
});
