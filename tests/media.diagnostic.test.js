jest.mock('../lib/firestore', () => ({firestore:null}));
jest.mock('../lib/cache', () => ({redis:null, getCached:async () => null, setCache:async () => {}}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation:jest.fn(() => ({
  id:'diagnostic-observation', markDispatched:jest.fn(), settle:jest.fn(), releaseUnsent:jest.fn(),
}))}));
const express = require('express');
const request = require('supertest');
const {createHash, randomBytes} = require('crypto');
const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createMediaDiagnosticRouter, COLLECTION, ROUTE, MAX_TICKET_MS, EXECUTION_MS} = require('../lib/mediaDiagnostic');
const {MEDIA_CONTROL} = require('../lib/sharedAiStore');
const {EngineError} = require('../lib/engineError');
const job = require('../lib/jobContext');
const metrics = require('../lib/engineMetrics');
const {createVideoEvidence} = require('../lib/media/videoEvidence');
const gate = () => {let resolve;return {promise:new Promise(r => {resolve = r;}), resolve};};
const emptyResult = () => ({attempted:true, incomplete:false, places:[],
  coverage:{audio:{status:'complete', intervals:[[0, 1000]]}, visual:{status:'complete'}, fusion:{status:'complete'}}});

function setup({db = new FakeFirestore(), extract = jest.fn(async () => ({title:'Private source title'})),
  collect = jest.fn(async () => emptyResult()), now = Date.now, ticket = {}} = {}) {
  db.strictReadOrder = true;
  const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex');
  const createdAtMs=now();
  db.seed(COLLECTION, id, {schemaVersion:1, status:'pending',
    tokenHash:createHash('sha256').update(token).digest('hex'), userId:'operator-selected-user',
    url:'https://www.instagram.com/reel/DIAGNOSTIC/', createdAtMs, expiresAtMs:createdAtMs + MAX_TICKET_MS, ...ticket});
  const router = createMediaDiagnosticRouter({db, extract, collect, now});
  const app = express();
  app.use(ROUTE, router); // same ordering as index.js
  app.use(express.json());
  return {db, app, id, token, extract, collect, router,
    send:() => request(app).post(`${ROUTE}/${id}`).set('x-media-diagnostic-token', token),
    read:() => db.read(COLLECTION, id),
    stop:value => db.seed(MEDIA_CONTROL.collection, MEDIA_CONTROL.document, {schemaVersion:1, stopNewMediaDispatch:value})};
}

test('a clock tick during fixture creation cannot make a valid ticket exceed its maximum lifetime', async () => {
  let time=Date.now();
  const f=setup({now:()=>time++});
  expect((await f.send()).status).toBe(202);
  await f.router.whenIdle();
  expect(f.read().expiresAtMs-f.read().createdAtMs).toBe(MAX_TICKET_MS);
  expect(f.extract).toHaveBeenCalledTimes(1);
});

test('only the ticket capability authenticates; spoofed Firebase/admin/UID headers grant nothing', async () => {
  const f = setup();
  const spoof = await request(f.app).post(`${ROUTE}/${f.id}`).set('Authorization', 'Bearer fake')
    .set('x-admin-token', 'fake').set('x-user-id', 'operator-selected-user');
  expect(spoof.status).toBe(401); expect(spoof.body).toEqual({error:'unauthorized'});
  const wrong = await request(f.app).post(`${ROUTE}/${f.id}`).set('x-media-diagnostic-token', '0'.repeat(64));
  const missing = await request(f.app).post(`${ROUTE}/${'0'.repeat(32)}`).set('x-media-diagnostic-token', f.token);
  expect(wrong.status).toBe(404); expect(wrong.body).toEqual(missing.body);
  expect(wrong.headers['cache-control']).toBe('no-store');
  expect(f.extract).not.toHaveBeenCalled(); expect(f.read().status).toBe('pending');
});

test('body/query cannot change URL, UID, features, retry policy or token; parser is bounded', async () => {
  const f = setup();
  expect((await f.send().send({url:'https://attacker.test', userId:'spoof', features:{schemaVersion:2}})).status).toBe(400);
  expect((await f.send().query({url:'https://attacker.test'})).status).toBe(400);
  expect((await f.send().set('Content-Type', 'text/plain').send('x'.repeat(1025))).status).toBe(413);
  expect(f.extract).not.toHaveBeenCalled(); expect(f.read().status).toBe('pending');
});

test('limiter rejects repeated unauthenticated attempts before database access', async () => {
  const f = setup(), transactions = jest.spyOn(f.db, 'runTransaction');
  for (let i = 0; i < 6; i++) expect((await request(f.app).post(`${ROUTE}/${f.id}`)).status).toBe(401);
  const response = await request(f.app).post(`${ROUTE}/${f.id}`);
  expect(response.status).toBe(429); expect(response.body).toEqual({error:'rate_limited'});
  expect(transactions).not.toHaveBeenCalled();
});

test('two independent server routers atomically claim once; running and completed replays never redispatch', async () => {
  const started = gate(), finish = gate();
  const f = setup({collect:jest.fn(async () => {started.resolve(); await finish.promise; return emptyResult();})});
  const secondRouter = createMediaDiagnosticRouter({db:f.db, extract:f.extract, collect:f.collect});
  const secondApp = express(); secondApp.use(ROUTE, secondRouter);
  const responses = await Promise.all([f.send(), request(secondApp).post(`${ROUTE}/${f.id}`).set('x-media-diagnostic-token', f.token)]);
  expect(responses.map(r => r.status)).toEqual([202, 202]);
  await started.promise;
  expect((await f.send()).body).toEqual({status:'running', executionExpired:false});
  expect(f.extract).toHaveBeenCalledTimes(1); expect(f.collect).toHaveBeenCalledTimes(1);
  finish.resolve(); await Promise.all([f.router.whenIdle(), secondRouter.whenIdle()]);
  const replay = await f.send(); expect(replay.status).toBe(200); expect(replay.body).toEqual({status:'completed'});
  expect(f.collect).toHaveBeenCalledTimes(1);
});

test.each([
  {createdAtMs:Date.now() - 2000, expiresAtMs:Date.now() - 1000},
  {createdAtMs:Date.now(), expiresAtMs:Date.now() + MAX_TICKET_MS + 10000},
  {url:'https://127.0.0.1/private'}, {url:'https://www.instagram.com.attacker.test/reel/x/'},
  {tokenHash:'invalid'}, {status:'stopped'}, {status:'pending', claimId:'already-consumed'},
])('expired/malformed/stopped/consumed ticket cannot execute: %j', async ticket => {
  const f = setup({ticket}); await f.send(); await f.router.whenIdle();
  expect(f.extract).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
});

test.each([true, 'false', undefined])('media stop or malformed control fails closed and permanently stops pending ticket (%s)', async value => {
  const f = setup(); f.stop(value);
  expect((await f.send()).body).toEqual({status:'stopped'});
  f.stop(false); expect((await f.send()).body).toEqual({status:'stopped'});
  expect(f.extract).not.toHaveBeenCalled();
});

test('missing control permits execution, schema2 authority uses stored UID/URL and writes only private diagnostics', async () => {
  let captured;
  const f = setup({collect:jest.fn(async input => {
    captured = {...job.current()};
    expect(input).toMatchObject({url:'https://www.instagram.com/reel/DIAGNOSTIC/', retryOperations:[], baselinePlaces:[]});
    await job.assertActive(); await captured.validateProviderDispatch();
    metrics.current().providerCall({provider:'openai', rateKey:'openai_mini_transcribe', stage:'transcription',
      outcome:'success', tokens:{textInput:0, audioInput:20, output:10}, submittedAudioSeconds:1});
    return {...emptyResult(), places:[{name:'Cafe', city:'Kyoto', evidenceRefs:[{quote:'raw transcript'}],
      transcript:'raw transcript', frame:Buffer.from('frame'), address:'https://cdn.test/signed?secret=abc'}],
      raw:'secret', retryOperations:[{kind:'asr_chunk', generation:1}]};
  })});
  await f.send(); await f.router.whenIdle();
  expect(captured).toMatchObject({userId:'operator-selected-user', features:{schemaVersion:2,
    versions:{mediaEvidence:'media-evidence-v1', languageRouting:'multilingual-v1'}}});
  expect(captured.jobId).toBeUndefined(); expect(captured.leaseOwner).toBeUndefined();
  expect(captured.deadline - f.read().claimedAtMs).toBe(EXECUTION_MS);
  expect(f.extract).toHaveBeenCalledWith(f.read().url);
  expect([...f.db.collections].filter(([, docs]) => docs.size).map(([name]) => name)).toEqual([COLLECTION]);
  expect(f.db.collections.has('pins')).toBe(false); expect(f.db.collections.has('enrichmentJobs')).toBe(false);
  const report = f.read().result;
  expect(report.places).toEqual([{name:'Cafe', city:'Kyoto', country:'', address:'[redacted]', source:'unknown'}]);
  expect(report.metrics.providerCalls).toHaveLength(1);
  expect(report.metrics.providerCalls[0].tokens.audioInput).toBe(20);
  expect(report.metrics.processingMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(report)).not.toMatch(/raw transcript|evidenceRefs|signed\?|retryOperations|Private source title|secret/);
  expect(JSON.stringify(f.read())).not.toContain(f.token);
});

test('claim commit acknowledgement failure is never followed by execution or reclaim', async () => {
  const f = setup();
  const transact = f.db.runTransaction.bind(f.db); let once = true;
  f.db.runTransaction = async work => {
    const outcome = await transact(work);
    if (once) {once = false; throw new Error('unknown commit acknowledgement');}
    return outcome;
  };
  expect((await f.send()).status).toBe(503);
  expect(f.read().status).toBe('running');
  expect((await f.send()).body.status).toBe('running');
  expect(f.extract).not.toHaveBeenCalled();
});
test.each(['media_reference','private transcript https://secret.test'])('response diagnostics expose only allowlisted reason codes (%s)',async reason=>{
  const error=new EngineError('invalid_response',{stage:'video_vision'});
  Object.defineProperty(error,'aiResponseReason',{value:reason});
  const f=setup({collect:jest.fn(async()=>({...emptyResult(),incomplete:true,error}))});
  await f.send();await f.router.whenIdle();
  expect(f.read().result.responseValidation).toBe(reason==='media_reference'?reason:undefined);
  expect(JSON.stringify(f.read().result)).not.toContain('private transcript');
  expect(f.collect).toHaveBeenCalledTimes(1);
});

test('nonempty audio coverage persists under Firestore nested-array constraints', async () => {
  const f = setup();
  const validate = (value, inArray = false) => {
    if (Array.isArray(value)) {
      if (inArray) throw new Error('Firestore cannot contain directly nested arrays');
      value.forEach(item => validate(item, true));
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(item => validate(item, false));
    }
  };
  expect(() => validate({intervals:[[0,1000]]})).toThrow('nested arrays');
  const transact = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = work => transact(tx => {
    const update = tx.update.bind(tx);
    tx.update = (ref, data, ...rest) => {validate(data); return update(ref, data, ...rest);};
    return work(tx);
  });
  await f.send(); await f.router.whenIdle();
  expect(f.read()).toMatchObject({status:'completed',result:{
    coverage:{audio:{status:'complete',intervals:[{startMs:0,endMs:1000}]}}
  }});
  expect((await f.send()).body).toEqual({status:'completed'});
  expect(f.collect).toHaveBeenCalledTimes(1);
});

test('crashed running ticket remains consumed past its execution deadline and ticket expiry', async () => {
  const now = Date.now();
  const f = setup({now:() => now, ticket:{status:'running', claimId:'crashed', deadlineMs:now - 1,
    createdAtMs:now - 2000, expiresAtMs:now - 1000}});
  expect((await f.send()).body).toEqual({status:'running', executionExpired:true});
  expect(f.extract).not.toHaveBeenCalled();
});

test('execution expiry aborts, records timeout and ignores late source completion forever', async () => {
  const source = gate(), began = gate(); let context;
  const f = setup({ticket:{expiresAtMs:Date.now() + 250}, extract:jest.fn(async () => {
    context = job.current(); began.resolve(); return source.promise;
  })});
  await f.send(); await began.promise; await f.router.whenIdle();
  expect(context.signal.aborted).toBe(true); expect(f.read().status).toBe('timed_out');
  expect(f.read().result.errors).toEqual(['dependency_timeout']);
  source.resolve({title:'late'}); await new Promise(resolve => setImmediate(resolve));
  await f.send(); expect(f.collect).not.toHaveBeenCalled(); expect(f.extract).toHaveBeenCalledTimes(1);
});

test('fired execution cutoff stays timed_out even when wall clock still precedes its deadline', async () => {
  // Timers and Date.now can disagree at the millisecond boundary (or across
  // a wall-clock adjustment). A fixed authority clock reproduces this without
  // relying on the CI runner happening to wake just before Date.now advances.
  const time=Date.now(),source=gate(),began=gate();let context;
  const f=setup({now:()=>time,ticket:{expiresAtMs:time+100},extract:jest.fn(async()=>{
    context=job.current();began.resolve();return source.promise;
  })});
  await f.send();await began.promise;await f.router.whenIdle();
  expect(time).toBeLessThan(f.read().deadlineMs);
  expect(context.signal.aborted).toBe(true);
  expect(f.read()).toMatchObject({status:'timed_out',result:{errors:['dependency_timeout']}});
  source.resolve({title:'late'});await new Promise(resolve=>setImmediate(resolve));
  await f.send();expect(f.collect).not.toHaveBeenCalled();expect(f.extract).toHaveBeenCalledTimes(1);
});

test.each(['rate_limited', 'access_blocked', 'dependency_timeout'])('source %s never starts a media fallback', async code => {
  const f = setup({extract:jest.fn(async () => {throw new EngineError(code, {stage:'source'});})});
  await f.send(); await f.router.whenIdle(); await f.send();
  expect(f.collect).not.toHaveBeenCalled(); expect(f.extract).toHaveBeenCalledTimes(1);
  expect(f.read().result.errors).toEqual([code]);
  expect(f.read().status).toBe('failed'); // A dependency timeout is not the diagnostic's execution cutoff.
});

test('subtitle 429 accompanying metadata never starts discovery/download', async () => {
  const f = setup({extract:jest.fn(async () => ({title:'usable', subtitle_failures:[{code:'rate_limited'}]}))});
  await f.send(); await f.router.whenIdle(); expect(f.collect).not.toHaveBeenCalled();
  expect(f.read().result.errors).toEqual(['rate_limited']);
});

test.each(['stop', 'revoke', 'replace'])('authority is rechecked after source and before new work (%s)', async mode => {
  const f = setup({extract:jest.fn(async () => {
    if (mode === 'stop') f.stop(true);
    else await f.db.collection(COLLECTION).doc(f.id).update(mode === 'revoke' ? {status:'stopped'} : {userId:'replacement'});
    return {};
  })});
  await f.send(); await f.router.whenIdle(); expect(f.collect).not.toHaveBeenCalled();
  if (mode === 'replace') expect(f.read().result).toBeUndefined();
  else expect(f.read()).toMatchObject({status:'stopped', result:{errors:['attempt_stopped']}});
});

test('completed partial evidence survives stop; raw errors are not persisted or returned', async () => {
  const f = setup({collect:jest.fn(async () => {
    f.stop(true);
    return {...emptyResult(), incomplete:true, places:[{name:'Cafe before stop'}],
      error:Object.assign(new EngineError('attempt_stopped'), {cause:new Error('secret signed URL'), stack:'secret'})};
  })});
  await f.send(); await f.router.whenIdle();
  expect(f.read()).toMatchObject({status:'stopped', result:{places:[{name:'Cafe before stop'}], errors:['attempt_stopped']}});
  expect(JSON.stringify(f.read())).not.toContain('secret');
  expect((await f.send()).body).toEqual({status:'stopped'});
});

test('real coordinator preserves partial places when fusion is stopped, without enrichment/pin access', async () => {
  let f;
  const collect = createVideoEvidence({
    readManifest:async () => null, writeManifest:jest.fn(),
    discover:async () => ({availability:'available'}),
    acquire:async () => ({contentDigest:'a'.repeat(64), bytes:50, dispose:async () => {}}),
    probe:async () => ({durationMs:1000, hasAudio:false}), audio:jest.fn(), transcribe:jest.fn(),
    frames:async () => ({frames:[{digest:'b'.repeat(64), timestampMs:0, width:2, height:2}]}),
    vision:async () => ({places:[{name:'Cafe', source:'vision', requiresSelection:true}],
      observations:[{evidenceId:'frame:a', quote:'Cafe'}]}),
    fusion:async () => {f.stop(true); await job.current().validateProviderDispatch(); return {places:[]};},
  });
  f = setup({collect}); await f.send(); await f.router.whenIdle();
  expect(f.read()).toMatchObject({status:'stopped', result:{places:[{name:'Cafe'}], incomplete:true,
    coverage:{visual:{status:'complete'}, fusion:{status:'failed'}}}});
  expect([...f.db.collections.keys()].sort()).toEqual([COLLECTION, MEDIA_CONTROL.collection].sort());
});

test.each([false, true])('real shared dispatch uses diagnostic authority/accounting and never resends (late stop=%s)', async lateStop => {
  const {createSharedAiOperations, SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
  const {withProvider} = require('../lib/providerRuntime');
  const {beginProviderObservation} = require('../lib/engineBudget');
  const db = new FakeFirestore(), operations = createSharedAiOperations({firestore:db});
  const paid = jest.fn(async () => {
    expect(f.read().status).toBe('running');
    expect(job.current().userId).toBe('operator-selected-user');
    expect(job.current().jobId).toBeUndefined();
    return {ok:true, usage:{input_tokens:2, output_tokens:1}};
  });
  const f = setup({db, collect:jest.fn(async () => {
    const result = emptyResult();
    try {
      await operations.runSharedAiOperation({kind:'asr_chunk', provider:'openai', stage:'transcription',
        scope:SERVER_PUBLIC_SCOPE, model:'synthetic', input:{digest:'a'.repeat(64)}, promptVersion:1,
        schemaVersion:1, optionsVersion:1, validate:value => value?.ok === true}, async ({sharedOperation}) => {
        if (lateStop) {
          const authorize = sharedOperation.authorizeDispatch.bind(sharedOperation);
          sharedOperation.authorizeDispatch = async args => {const marker = await authorize(args); f.stop(true); return marker;};
        }
        return withProvider('openai', paid, 1, {stage:'transcription'});
      });
    } catch (error) {result.error = error; result.incomplete = true;}
    return result;
  })});
  await f.send(); await f.router.whenIdle(); await f.send();
  expect(f.collect).toHaveBeenCalledTimes(1); expect(paid).toHaveBeenCalledTimes(lateStop ? 0 : 1);
  expect(f.read().status).toBe(lateStop ? 'stopped' : 'completed');
  expect(beginProviderObservation).toHaveBeenCalled();
  const observation = beginProviderObservation.mock.calls.at(-1)[0];
  expect(observation.context.userId).toBe('operator-selected-user');
  expect(observation.context.attemptId).toMatch(/^media-diagnostic:/);
  expect(db.collections.has('pins')).toBe(false); expect(db.collections.has('enrichmentJobs')).toBe(false);
});
