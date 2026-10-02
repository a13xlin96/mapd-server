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
const {DEFAULT_MEDIA_CONFIG} = require('../lib/media/mediaConfig');
const audioOnlyTicket = Object.freeze({schemaVersion:2, analysisMode:'audio-only'});
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

test.each([{}, audioOnlyTicket])('HTTP body/query cannot select or override analysis mode (%j)', async ticket => {
  const f = setup({ticket});
  expect((await f.send().send({analysisMode:'audio-only'})).body).toEqual({error:'empty_request_required'});
  expect((await f.send().query({analysisMode:'audio-only'})).body).toEqual({error:'empty_request_required'});
  expect((await f.send().send({mediaPolicy:{policyVersion:'media-v2', analysisMode:'audio-only'}})).status).toBe(400);
  expect(f.extract).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  expect(f.read().status).toBe('pending'); expect(f.read().claimId).toBeUndefined();
});

test.each([undefined, null, '', 'audio-video', 'audio-only ', 'AUDIO-ONLY', false, 1, [], {}, ['audio-only']]
  .flatMap(value => [[1, value], [2, value]]))(
  'server claim rejects an explicit malformed trusted mode (schema=%s, mode=%j)', async (schemaVersion, analysisMode) => {
    const f = setup({ticket:{schemaVersion, analysisMode}});
    const response = await f.send(); await f.router.whenIdle();
    expect(response.status).toBe(404); expect(response.body).toEqual({error:'not_found'});
    expect(f.read().status).toBe('pending'); expect(f.read().claimId).toBeUndefined();
    expect(f.extract).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

test.each([
  {schemaVersion:1, analysisMode:'audio-only'}, {schemaVersion:2},
  {schemaVersion:3, analysisMode:'audio-only'}, {schemaVersion:'2', analysisMode:'audio-only'},
])('server claim rejects incompatible remote ticket version/mode without work (%j)', async ticket => {
  const f = setup({ticket});
  const response = await f.send(); await f.router.whenIdle();
  expect(response.status).toBe(404); expect(response.body).toEqual({error:'not_found'});
  expect(f.read().status).toBe('pending'); expect(f.read().claimId).toBeUndefined();
  expect(f.extract).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
});

test('limiter rejects repeated unauthenticated attempts before database access', async () => {
  const f = setup(), transactions = jest.spyOn(f.db, 'runTransaction');
  for (let i = 0; i < 6; i++) expect((await request(f.app).post(`${ROUTE}/${f.id}`)).status).toBe(401);
  const response = await request(f.app).post(`${ROUTE}/${f.id}`);
  expect(response.status).toBe(429); expect(response.body).toEqual({error:'rate_limited'});
  expect(transactions).not.toHaveBeenCalled();
});

test.each([{}, audioOnlyTicket])('two independent server routers atomically claim once; replays never redispatch (%j)', async ticket => {
  const started = gate(), finish = gate();
  const f = setup({ticket, collect:jest.fn(async () => {started.resolve(); await finish.promise; return emptyResult();})});
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
    return {...emptyResult(), analysisMode:'audio-only', places:[{name:'Cafe', city:'Kyoto', evidenceRefs:[{quote:'raw transcript'}],
      transcript:'raw transcript', frame:Buffer.from('frame'), address:'https://cdn.test/signed?secret=abc'}],
      raw:'secret', retryOperations:[{kind:'asr_chunk', generation:1}]};
  })});
  await f.send(); await f.router.whenIdle();
  expect(captured).toMatchObject({userId:'operator-selected-user', features:{schemaVersion:2,
    versions:{mediaEvidence:'media-evidence-v1', languageRouting:'multilingual-v1'}}});
  expect(captured.jobId).toBeUndefined(); expect(captured.leaseOwner).toBeUndefined();
  expect(captured.features.media.policy).toEqual(DEFAULT_MEDIA_CONFIG);
  expect(f.read().schemaVersion).toBe(1);
  expect(Object.hasOwn(f.read(), 'analysisMode')).toBe(false);
  expect(Object.hasOwn(captured.features.media.policy, 'analysisMode')).toBe(false);
  expect(captured.deadline - f.read().claimedAtMs).toBe(EXECUTION_MS);
  expect(f.extract).toHaveBeenCalledWith(f.read().url);
  expect([...f.db.collections].filter(([, docs]) => docs.size).map(([name]) => name)).toEqual([COLLECTION]);
  expect(f.db.collections.has('pins')).toBe(false); expect(f.db.collections.has('enrichmentJobs')).toBe(false);
  const report = f.read().result;
  expect(Object.hasOwn(report, 'analysisMode')).toBe(false); // Ignore any collector-supplied mode.
  expect(report.places).toEqual([{name:'Cafe', city:'Kyoto', country:'', address:'[redacted]', source:'unknown'}]);
  expect(report.metrics.providerCalls).toHaveLength(1);
  expect(report.metrics.providerCalls[0].tokens.audioInput).toBe(20);
  expect(report.metrics.processingMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(report)).not.toMatch(/raw transcript|evidenceRefs|signed\?|retryOperations|Private source title|secret/);
  expect(JSON.stringify(f.read())).not.toContain(f.token);
});

test('only the trusted audio-only ticket selects an immutable v2 policy and sanitized result mode', async () => {
  let captured;
  const f = setup({ticket:audioOnlyTicket, collect:jest.fn(async input => {
    captured = job.current();
    expect(input).toMatchObject({retryOperations:[], baselinePlaces:[]});
    expect(Object.hasOwn(input, 'analysisMode')).toBe(false);
    await captured.validateProviderDispatch();
    return {...emptyResult(), analysisMode:'https://secret.test', raw:'private transcript'};
  })});
  const response = await f.send().set('x-media-analysis-mode', 'audio-video');
  expect(response.status).toBe(202);
  expect(response.body).toEqual({status:'running', executionExpired:false});
  await f.router.whenIdle();
  expect(captured.features.media.policy).toEqual({...DEFAULT_MEDIA_CONFIG, policyVersion:'media-v2', analysisMode:'audio-only'});
  expect(Object.isFrozen(captured.features)).toBe(true);
  expect(Object.isFrozen(captured.features.media)).toBe(true);
  expect(Object.isFrozen(captured.features.media.policy)).toBe(true);
  expect(captured.jobId).toBeUndefined(); expect(captured.leaseOwner).toBeUndefined();
  expect(f.read()).toMatchObject({schemaVersion:2, status:'completed', analysisMode:'audio-only', result:{analysisMode:'audio-only'}});
  expect(JSON.stringify(f.read().result)).not.toMatch(/secret|private transcript/);
  expect([...f.db.collections].filter(([, docs]) => docs.size).map(([name]) => name)).toEqual([COLLECTION]);
});

test('mode headers cannot enable audio-only on a default ticket', async () => {
  const f = setup({collect:jest.fn(async () => {
    expect(job.current().features.media.policy).toEqual(DEFAULT_MEDIA_CONFIG);
    return emptyResult();
  })});
  await f.send().set('x-media-analysis-mode', 'audio-only'); await f.router.whenIdle();
  expect(f.collect).toHaveBeenCalledTimes(1);
  expect(Object.hasOwn(f.read().result, 'analysisMode')).toBe(false);
});

test.each([
  [{}, {analysisMode:'audio-only'}], [audioOnlyTicket, {}],
  [audioOnlyTicket, {analysisMode:'audio-video'}], [{}, {analysisMode:undefined}],
])('changing mode after claim prevents further work and result publication (%j -> %j)', async (ticket, replacement) => {
  const f = setup({ticket, extract:jest.fn(async () => {
    const updated = {...f.read()}; delete updated.analysisMode;
    f.db.seed(COLLECTION, f.id, {...updated, ...replacement});
    return {};
  })});
  await f.send(); await f.router.whenIdle();
  expect(f.extract).toHaveBeenCalledTimes(1); expect(f.collect).not.toHaveBeenCalled();
  expect(f.read().result).toBeUndefined();
  // A mode edit never restores a consumed claim, even if status is reset.
  await f.db.collection(COLLECTION).doc(f.id).update({status:'pending'});
  await f.send(); await f.router.whenIdle();
  expect(f.extract).toHaveBeenCalledTimes(1); expect(f.collect).not.toHaveBeenCalled();
});

test.each(['mode', 'schema'])('changing audio-only ticket %s during collection fences shared dispatch and publication', async field => {
  let dispatchError, capturedPolicy;
  const f = setup({ticket:audioOnlyTicket, collect:jest.fn(async () => {
    const updated = {...f.read()};
    if (field === 'mode') delete updated.analysisMode;
    else updated.schemaVersion = 1;
    f.db.seed(COLLECTION, f.id, updated);
    try {await job.current().validateProviderDispatch();} catch (error) {dispatchError = error;}
    capturedPolicy = job.current().features.media.policy;
    return emptyResult();
  })});
  await f.send(); await f.router.whenIdle(); await f.send();
  expect(dispatchError).toMatchObject({code:'attempt_stopped'});
  expect(capturedPolicy.analysisMode).toBe('audio-only');
  expect(f.collect).toHaveBeenCalledTimes(1); expect(f.read().result).toBeUndefined();
});

test.each([[audioOnlyTicket, 1], [audioOnlyTicket, 3], [{}, 2]])(
  'changing schema after claim prevents collection/publication and never renews authority (%j -> %s)', async (ticket, schemaVersion) => {
    const f = setup({ticket, extract:jest.fn(async () => {
      await f.db.collection(COLLECTION).doc(f.id).update({schemaVersion});
      return {};
    })});
    await f.send(); await f.router.whenIdle();
    expect(f.extract).toHaveBeenCalledTimes(1); expect(f.collect).not.toHaveBeenCalled();
    expect(f.read().result).toBeUndefined();
    expect(f.read().analysisMode).toBe(ticket.analysisMode);
    // Restoring a valid schema and resetting status cannot clear paid fences.
    await f.db.collection(COLLECTION).doc(f.id).update({schemaVersion:ticket.schemaVersion || 1, status:'pending'});
    expect((await f.send()).status).toBe(410); await f.router.whenIdle();
    expect(f.extract).toHaveBeenCalledTimes(1); expect(f.collect).not.toHaveBeenCalled();
  });

test.each([{}, audioOnlyTicket])('claim commit acknowledgement failure never executes or reclaims (%j)', async ticket => {
  const f = setup({ticket});
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
  const timing={durationMs:1000,probe:{containerDurationMs:1000},preparedChunkCount:1,
    preparedIntervals:[{startMs:0,endMs:1000}],coverageGapCount:0,coverageGaps:[]};
  const f = setup({collect:jest.fn(async()=>({...emptyResult(),timing}))});
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
    timing,
    coverage:{audio:{status:'complete',intervals:[{startMs:0,endMs:1000}]}}
  }});
  expect((await f.send()).body).toEqual({status:'completed'});
  expect(f.collect).toHaveBeenCalledTimes(1);
});

test('private diagnostics preserve exact crab timing numbers and strip every nonallowlisted field',async()=>{
  const durationMs=32806.939,endMs=32718.312500000004;
  const probe={containerDurationMs:durationMs,videoDurationMs:32700.000000000004,audioDurationMs:durationMs,
    containerStartMs:0,videoStartMs:0,audioStartMs:-0.0625};
  const expected={durationMs,probe,audioStartMs:0,preparedChunkCount:2,
    preparedIntervals:[{startMs:0,endMs:20000},{startMs:19000,endMs}],
    coverageGapCount:1,coverageGaps:[{startMs:endMs,endMs:durationMs}]};
  const f=setup({ticket:audioOnlyTicket,collect:jest.fn(async()=>({...emptyResult(),incomplete:true,
    coverage:{audio:{status:'partial',reason:'audio_unread',intervals:[[0,endMs]]},visual:{status:'unavailable'},fusion:{status:'complete'}},
    timing:{...expected,url:'https://private.invalid',text:'private transcript',audioBytes:Buffer.from('private'),
      probe:{...probe,stderr:'private stderr',path:'/private/media'},
      preparedIntervals:expected.preparedIntervals.map(v=>({...v,audioSha256:'a'.repeat(64),quote:'private transcript'})),
      coverageGaps:[{...expected.coverageGaps[0],url:'https://private.invalid'}]},
  }))});
  await f.send();await f.router.whenIdle();
  const saved=f.read();
  expect(saved).toMatchObject({schemaVersion:2,status:'partial',result:{schemaVersion:1,analysisMode:'audio-only',timing:expected}});
  expect(saved.result.timing).toEqual(expected);
  expect(saved.result.coverage.audio.intervals).toEqual([{startMs:0,endMs}]);
  expect(JSON.stringify(saved.result.timing)).not.toMatch(/private|https|quote|audioBytes|audioSha256/);
  expect((await f.send()).body).toEqual({status:'partial'});expect(f.collect).toHaveBeenCalledTimes(1);
});

test('timing numeric fields and interval output are bounded independently of untrusted extras',async()=>{
  const interval={startMs:1.125,endMs:2.0625,url:'https://private.invalid'};
  const invalid=[null,{},[0,1],{startMs:0,endMs:Infinity},{startMs:0,endMs:NaN},
    {startMs:-1,endMs:2},{startMs:0,endMs:3001},{startMs:2,endMs:2},{startMs:0,endMs:'2'}];
  const f=setup({collect:jest.fn(async()=>({...emptyResult(),timing:{durationMs:3000,audioStartMs:'0',
    probe:{containerDurationMs:Infinity,videoDurationMs:'3',audioDurationMs:180001,containerStartMs:-180001,videoStartMs:NaN,audioStartMs:null},
    separateAudioProbe:{containerDurationMs:3000,containerStartMs:-1,audioDurationMs:-1},
    preparedChunkCount:33,coverageGapCount:1002,
    preparedIntervals:[...invalid,...Array(100).fill(interval)],coverageGaps:Array(100).fill(interval)}}))});
  await f.send();await f.router.whenIdle();
  expect(f.read().result.timing).toEqual({durationMs:3000,separateAudioProbe:{containerDurationMs:3000,containerStartMs:-1},
    preparedIntervals:Array(32-invalid.length).fill({startMs:1.125,endMs:2.0625}),
    coverageGaps:Array(64).fill({startMs:1.125,endMs:2.0625})});
});

test('available-audio reason preserves the measured container gap without inventing covered speech',async()=>{
  const durationMs=32806.939,endMs=32718.312500000004;
  const timing={durationMs,probe:{containerDurationMs:durationMs,videoDurationMs:32700.000000000004,audioDurationMs:durationMs},
    preparedChunkCount:2,preparedIntervals:[{startMs:0,endMs:20000},{startMs:19000,endMs}],
    coverageGapCount:1,coverageGaps:[{startMs:endMs,endMs:durationMs}]};
  const f=setup({ticket:audioOnlyTicket,collect:jest.fn(async()=>({...emptyResult(),timing,coverage:{
    audio:{status:'complete',reason:'available_audio_complete',intervals:[[0,endMs]]},
    visual:{status:'unavailable',reason:'disabled_by_policy'},fusion:{status:'complete'},
  }}))});
  await f.send();await f.router.whenIdle();
  expect(f.read()).toMatchObject({status:'completed',result:{incomplete:false,timing,coverage:{audio:{
    status:'complete',reason:'available_audio_complete',intervals:[{startMs:0,endMs}],
  }}}});
  expect(f.read().result.timing).toEqual(timing);
  expect((await f.send()).body).toEqual({status:'completed'});expect(f.collect).toHaveBeenCalledTimes(1);
});

test.each([undefined,null,{}, {durationMs:'3000'}, {durationMs:NaN}, {durationMs:Infinity}, {durationMs:0}, {durationMs:180001}])(
  'absent or invalid optional timing preserves the legacy diagnostic shape (%j)',async timing=>{
    const f=setup({collect:jest.fn(async()=>({...emptyResult(),timing}))});
    await f.send();await f.router.whenIdle();
    expect(f.read().result.schemaVersion).toBe(1);expect(f.read().status).toBe('completed');
    expect(f.read().result).not.toHaveProperty('timing');
  });

test.each([0.125, 0.6895])('diagnostic preserves the real facade submillisecond tail reason and %s ms gap', async gap => {
  const {createTranscriptionService} = require('../lib/media/transcriptionService');
  const transcription = createTranscriptionService({providers:{openai:{id:'openai',
    model:'gpt-4o-mini-transcribe-2025-12-15', version:'diagnostic-tail-fixture-v1',
    transcribeChunk:jest.fn(async () => ({text:'Cafe'}))}},
    sharedOperation:async (_options, work) => work(), providerCall:async (_provider, work) => work()});
  const durationMs = 20000, endMs = durationMs - gap;
  const f = setup({ticket:audioOnlyTicket, collect:jest.fn(async () => {
    const transcript = await transcription.transcribe({durationMs, mediaDigest:'a'.repeat(64),
      chunks:[{audioBytes:Buffer.from('RIFF0000WAVEdiagnostic-fixture'), startMs:0, endMs}]});
    expect(transcript.coverage).toEqual({status:'complete', reason:'submillisecond_tail', intervals:[[0, endMs]]});
    return {...emptyResult(), coverage:{audio:transcript.coverage,
      visual:{status:'unavailable', reason:'disabled_by_policy'}, fusion:{status:'complete'}}};
  })});
  await f.send(); await f.router.whenIdle();
  expect(f.read()).toMatchObject({status:'completed', result:{incomplete:false, coverage:{audio:{
    status:'complete', reason:'submillisecond_tail', intervals:[{startMs:0, endMs}],
  }}}});
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

test.each([{}, audioOnlyTicket])('execution expiry aborts and ignores late source completion forever (%j)', async ticket => {
  const source = gate(), began = gate(); let context;
  const f = setup({ticket:{...ticket, expiresAtMs:Date.now() + 250}, extract:jest.fn(async () => {
    context = job.current(); began.resolve(); return source.promise;
  })});
  await f.send(); await began.promise; await f.router.whenIdle();
  expect(context.signal.aborted).toBe(true); expect(f.read().status).toBe('timed_out');
  expect(f.read().result.errors).toEqual(['dependency_timeout']);
  expect(f.read().result.analysisMode).toBe(ticket.analysisMode);
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

test.each([{}, audioOnlyTicket])('real coordinator obeys the ticket policy with measured zero frame/vision work for audio-only (%j)', async ticket => {
  const recordCall = stage => metrics.current().providerCall({provider:stage === 'transcription' ? 'openai' : 'anthropic',
    rateKey:stage === 'transcription' ? 'openai_mini_transcribe' : 'unknown', stage, outcome:'success'});
  const audio = jest.fn(async () => [{startMs:0, endMs:1000}]);
  const transcribe = jest.fn(async () => {
    recordCall('transcription');
    return {segments:[{evidenceId:'asr:0', text:'Cafe Kyoto', startMs:0, endMs:1000}],
      coverage:{status:'complete', intervals:[[0,1000]]}};
  });
  const frames = jest.fn(async () => ({scannedFrames:1,
    frames:[{digest:'b'.repeat(64), timestampMs:0, width:2, height:2}]}));
  const vision = jest.fn(async () => {recordCall('video_vision'); return {places:[], observations:[]};});
  const fusion = jest.fn(async () => {recordCall('media_fusion'); return {places:[{name:'Cafe Kyoto', source:'transcript'}]};});
  const dispose = jest.fn(async () => {});
  const collect = createVideoEvidence({
    readManifest:async () => null, writeManifest:jest.fn(),
    discover:async () => ({availability:'available'}),
    acquire:async () => ({contentDigest:'a'.repeat(64), bytes:50, dispose}),
    probe:async () => ({durationMs:1000, hasAudio:true}), audio, transcribe, frames, vision, fusion,
  });
  const f = setup({ticket, collect});
  await f.send(); await f.router.whenIdle(); await f.send();
  const audioOnly = ticket.analysisMode === 'audio-only', report = f.read().result;
  expect(f.read().status).toBe('completed');
  expect(audio).toHaveBeenCalledTimes(1); expect(transcribe).toHaveBeenCalledTimes(1);
  expect(frames).toHaveBeenCalledTimes(audioOnly ? 0 : 1); expect(vision).toHaveBeenCalledTimes(audioOnly ? 0 : 1);
  expect(fusion).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  expect(report.analysisMode).toBe(ticket.analysisMode);
  expect(report.coverage.audio).toEqual({status:'complete', reason:null, intervals:[{startMs:0, endMs:1000}]});
  expect(report.coverage.visual).toEqual({status:audioOnly ? 'unavailable' : 'complete',
    reason:audioOnly ? 'disabled_by_policy' : 'sampled_frames_only', intervals:[]});
  expect(report.metrics.providerCalls.filter(call => call.stage === 'video_vision')).toHaveLength(audioOnly ? 0 : 1);
  expect(report.metrics.providerCalls.filter(call => call.stage === 'transcription')).toHaveLength(1);
  expect(report.metrics.providerCalls.filter(call => call.stage === 'media_fusion')).toHaveLength(1);
  if (audioOnly) {
    expect(report.metrics.operations.framesDecoded).toBeUndefined();
    expect(report.metrics.operations.framesSelected).toBeUndefined();
  }
  expect(f.db.collections.has('pins')).toBe(false); expect(f.db.collections.has('enrichmentJobs')).toBe(false);
});

test.each([[false, {}], [true, {}], [false, audioOnlyTicket], [true, audioOnlyTicket]])(
  'real shared dispatch uses diagnostic authority/accounting and never resends (late stop=%s, ticket=%j)', async (lateStop, ticket) => {
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
  const f = setup({db, ticket, collect:jest.fn(async () => {
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
