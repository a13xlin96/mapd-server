// Real provider wrapper + real observation ledger, with only external services
// replaced. No provider, Redis, Firestore, or paid network traffic is possible.
jest.mock('../lib/cache', () => ({redis: null, getCached: jest.fn(), setCache: jest.fn()}));
jest.mock('../lib/firestore', () => ({firestore: null}));
jest.mock('../lib/engineMetrics', () => ({current: jest.fn(() => null)}));
jest.mock('../lib/engineBudget', () => ({...jest.requireActual('../lib/engineBudget'), beginProviderObservation: jest.fn()}));

const budgetModule = require('../lib/engineBudget');
const {withProvider} = require('../lib/providerRuntime');
const jobContext = require('../lib/jobContext');
const {createSharedAiOperations, SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {EngineError} = require('../lib/engineError');
const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createEngineBudgetWorker} = require('../lib/engineBudgetWorker');

const DAY = '2026-09-18';
const usage = {input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
const response = {usage, answer: 'venue'};
const observation = {stage: 'ai', rateKey: 'haiku', descriptor: {
  model: 'claude-haiku-4-5-20251001', inputBytes: 1000, imageTokens: 0, maxOutputTokens: 200, cacheEnabled: false,
}};
const context = () => ({userId: 'verified-account', jobId: 'integration-attempt', deadline: Date.now() + 10000});
const gate = () => { let resolve; return {promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value)}; };
const flushMicrotasks = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

function setup(options = {}) {
  const db = new FakeFirestore(); db.strictReadOrder = true;
  const ledger = budgetModule.createEngineBudget({db, journal: null, logger: null, now: () => `${DAY}T12:00:00.000Z`, ...options});
  const worker = createEngineBudgetWorker({db, journal: null, logger: null});
  const handles = [], writes = [];
  budgetModule.beginProviderObservation.mockImplementation(input => {
    const real = ledger.beginProviderObservation(input);
    const h = {id: real.id};
    for (const key of ['markDispatched', 'settle', 'releaseUnsent']) h[key] = jest.fn((...args) => {
      const pending = real[key](...args); writes.push(pending); return pending;
    });
    handles.push(h); return h;
  });
  const global = window => db.read(budgetModule.COLLECTIONS.counters, budgetModule.counterId('global', 'engine', window || DAY));
  const record = h => db.read(budgetModule.COLLECTIONS.calls, h.id);
  return {db, ledger, handles, writes, global, record, drain: async () => {await Promise.all(writes); await worker.tick();}};
}

beforeEach(() => jest.clearAllMocks());

test('stalled ledger stays completely off the provider critical path, including settlement', async () => {
  jest.useFakeTimers();
  try {
    const stalled = {collection: () => ({doc: () => ({})}), runTransaction: jest.fn(() => new Promise(() => {}))};
    const s = setup({db: stalled, timeoutMs: 25});
    const work = jest.fn(async () => response);
    let completed = false;
    const result = jobContext.run(context(), () => withProvider('anthropic', work, 1, observation))
      .then(value => { completed = true; return value; });
    // No clock advance: a wrapper awaiting ANY ledger write cannot complete.
    await flushMicrotasks();
    expect(stalled.runTransaction).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
    expect(await result).toBe(response);
    expect(s.handles[0].settle).toHaveBeenCalledWith({result: response, dispatched: true});
    await jest.runAllTimersAsync();
    await s.drain();
    expect(s.ledger.getDiagnostics().counts.ledger_timeout).toBe(3);
  } finally { jest.useRealTimers(); }
});

test.each([
  {db: null}, {prices: null}, {policy: {limits: 'broken'}},
  {db: {collection: () => ({doc: () => ({})}), runTransaction: async () => { throw new Error('ledger down'); }}},
  {policy: {...budgetModule.DEFAULT_POLICY, mode: 'enforce', emergencyStop: true,
    limits: {attemptCalls: 0, attemptMicrodollars: 0, accountDayMicrodollars: 0, globalDayMicrodollars: 0}}},
])('down/malformed ledger/rates/policy and zero caps cannot reject provider work: %j', async config => {
  const s = setup(config), work = jest.fn(async () => response);
  await expect(jobContext.run(context(), () => withProvider('anthropic', work, 1, observation))).resolves.toBe(response);
  await s.drain();
  expect(work).toHaveBeenCalledTimes(1);
  expect(s.handles).toHaveLength(1);
  expect(s.handles[0].markDispatched).toHaveBeenCalledTimes(1);
  expect(s.ledger.mode).toBe('observe');
});

test('one observation per physical request retains verified context, descriptors, signal, deadline and usage', async () => {
  const s = setup(), controller = new AbortController();
  const ctx = {...context(), signal: controller.signal};
  const work = jest.fn(async () => response);
  await jobContext.run(ctx, () => withProvider('anthropic', work, 1, observation));
  await s.drain();
  expect(budgetModule.beginProviderObservation).toHaveBeenCalledTimes(1);
  expect(budgetModule.beginProviderObservation).toHaveBeenCalledWith({provider: 'anthropic', stage: 'ai', rateKey: 'haiku',
    descriptor: observation.descriptor, context: ctx});
  expect(work).toHaveBeenCalledWith({signal: controller.signal, deadline: ctx.deadline});
  expect(s.handles[0].markDispatched).toHaveBeenCalledTimes(1);
  expect(s.handles[0].settle).toHaveBeenCalledTimes(1);
  expect(s.handles[0].releaseUnsent).not.toHaveBeenCalled();
  expect(s.record(s.handles[0])).toMatchObject({actualMicrodollars: 200, usage: {input: 100, output: 20}, owner: {kind: 'account'}});
  expect(s.global()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200});
});

test('each explicit physical retry gets a distinct observation and failed-call liability is retained', async () => {
  const s = setup(), work = jest.fn().mockRejectedValueOnce(new Error('provider timeout')).mockResolvedValueOnce(response);
  const invoke = () => jobContext.run(context(), () => withProvider('anthropic', work, 1, observation));
  await expect(invoke()).rejects.toMatchObject({code: 'dependency_timeout'});
  await expect(invoke()).resolves.toBe(response);
  await s.drain();
  expect(s.handles).toHaveLength(2);
  expect(s.handles[0].id).not.toBe(s.handles[1].id);
  expect(s.record(s.handles[0])).toMatchObject({actualMicrodollars: null, state: 'uncertain', uncertainLiabilityMicrodollars: 3024});
  expect(s.global()).toMatchObject({physicalCalls: 2, knownActualMicrodollars: 200, uncertainLiabilityMicrodollars: 3024});
});

test.each(['beforeProviderDispatch', 'sharedOperation'])('pre-dispatch %s fence failure releases unsent observation without provider work', async field => {
  const s = setup(), work = jest.fn(), fence = jest.fn(async () => { throw new EngineError('attempt_stopped'); });
  const ctx = {...context(), ...(field === 'sharedOperation' ? {sharedOperation: {authorizeDispatch: fence}} : {beforeProviderDispatch: fence})};
  await expect(jobContext.run(ctx, () => withProvider('anthropic', work, 1, observation))).rejects.toMatchObject({code: 'attempt_stopped'});
  await s.drain();
  expect(work).not.toHaveBeenCalled();
  expect(s.handles).toHaveLength(1);
  expect(s.handles[0].markDispatched).not.toHaveBeenCalled();
  expect(s.handles[0].settle).not.toHaveBeenCalled();
  expect(s.handles[0].releaseUnsent).toHaveBeenCalledTimes(1);
  expect(s.record(s.handles[0])).toMatchObject({state: 'released', dispatchedAt: null});
  expect(s.global()).toBeUndefined();
});

test('fencing is awaited and cancellation after authorization still releases unsent work', async () => {
  const s = setup(), barrier = gate(), controller = new AbortController(), work = jest.fn();
  const authorizeDispatch = jest.fn(() => barrier.promise);
  const ctx = {...context(), signal: controller.signal, sharedOperation: {authorizeDispatch}};
  const pending = jobContext.run(ctx, () => withProvider('anthropic', work, 1, observation));
  const rejected = expect(pending).rejects.toMatchObject({code: 'attempt_stopped'});
  await flushMicrotasks();
  expect(authorizeDispatch).toHaveBeenCalledWith({reservationId: s.handles[0].id});
  expect(work).not.toHaveBeenCalled();
  expect(s.handles[0].markDispatched).not.toHaveBeenCalled();
  controller.abort(); barrier.resolve();
  await rejected; await s.drain();
  expect(s.record(s.handles[0])).toMatchObject({state: 'released', dispatchedAt: null});
});

test('provider timeout records original reported error usage, not the normalized error', async () => {
  const s = setup(), original = Object.assign(new Error('timeout with private URL'), {usage});
  await expect(jobContext.run(context(), () => withProvider('anthropic', async () => { throw original; }, 1, observation)))
    .rejects.toMatchObject({code: 'dependency_timeout'});
  await s.drain();
  expect(s.handles[0].settle).toHaveBeenCalledWith({error: original, dispatched: true});
  expect(s.record(s.handles[0])).toMatchObject({outcome: 'failed', actualMicrodollars: 200});
  expect(JSON.stringify(s.record(s.handles[0]))).not.toContain('private URL');
});

test('cancellation after a successful provider response preserves reported spend', async () => {
  const s = setup(), controller = new AbortController();
  const ctx = {...context(), signal: controller.signal};
  await expect(jobContext.run(ctx, () => withProvider('anthropic', async () => { controller.abort(); return response; }, 1, observation)))
    .rejects.toMatchObject({code: 'attempt_stopped'});
  await s.drain();
  expect(s.handles[0].settle).toHaveBeenCalledTimes(1);
  expect(s.handles[0].releaseUnsent).not.toHaveBeenCalled();
  expect(s.global()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200, uncertainLiabilityMicrodollars: 0});
});

test('same-process and cross-coordinator followers plus warm results create zero additional observations', async () => {
  const s = setup(), sharedDb = new FakeFirestore(), held = gate();
  const cache = {getCached: jest.fn(async () => null), setCache: jest.fn(async () => {})};
  const a = createSharedAiOperations({firestore: sharedDb, cache, limits: {pollMs: 5}});
  const b = createSharedAiOperations({firestore: sharedDb, cache, limits: {pollMs: 5}});
  const options = {kind: 'integration-observation', input: {text: 'public evidence'}, scope: SERVER_PUBLIC_SCOPE,
    model: 'claude-haiku-4-5-20251001', promptVersion: '1', schemaVersion: 1, optionsVersion: '1', validate: v => v?.answer === 'venue'};
  const provider = jest.fn(() => held.promise);
  const produce = () => withProvider('anthropic', provider, 1, observation);
  const calls = [a, a, a, b].map((coordinator, i) => jobContext.run({userId: `user-${i}`, jobId: `job-${i}`},
    () => coordinator.runSharedAiOperation(options, produce)));
  for (let i = 0; i < 20 && !provider.mock.calls.length; i++) await new Promise(resolve => setImmediate(resolve));
  expect(provider).toHaveBeenCalledTimes(1);
  expect(budgetModule.beginProviderObservation).toHaveBeenCalledTimes(1);
  held.resolve(response);
  expect(await Promise.all(calls)).toEqual([response, response, response, response]);
  expect(await b.runSharedAiOperation(options, produce)).toEqual(response);
  await s.drain();
  expect(provider).toHaveBeenCalledTimes(1);
  expect(budgetModule.beginProviderObservation).toHaveBeenCalledTimes(1);
  expect(s.global()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200});
});

test('a completed cache hit never enters the provider wrapper or creates an observation', async () => {
  const s = setup();
  const shared = createSharedAiOperations({allowLocal: true,
    cache: {getCached: async () => response, setCache: jest.fn()}});
  const provider = jest.fn(async () => response);
  const result = await shared.runSharedAiOperation({kind: 'cached-observation', input: {text: 'cached'}, scope: SERVER_PUBLIC_SCOPE,
    model: 'haiku', promptVersion: '1', schemaVersion: 1, optionsVersion: '1', validate: v => v?.answer === 'venue'},
  () => withProvider('anthropic', provider, 1, observation));
  expect(result).toEqual(response);
  expect(provider).not.toHaveBeenCalled();
  expect(budgetModule.beginProviderObservation).not.toHaveBeenCalled();
  expect(s.global()).toBeUndefined();
});

test('a storage stall across midnight cannot move an unawaited physical call into the persistence day', async () => {
  const db = new FakeFirestore(), hold = gate(); let clock = `${DAY}T23:59:59.999Z`;
  const original = db.runTransaction.bind(db);
  db.runTransaction = async callback => { await hold.promise; return original(callback); };
  const s = setup({db, now: () => clock, timeoutMs: 1000});
  await jobContext.run(context(), () => withProvider('anthropic', async () => response, 1, observation));
  clock = '2026-09-19T00:00:00.100Z'; hold.resolve(); await s.drain();
  const call = db.read(budgetModule.COLLECTIONS.calls, s.handles[0].id);
  expect(call).toMatchObject({dispatchDay: DAY, actualMicrodollars: 200});
  expect(db.read(budgetModule.COLLECTIONS.counters, budgetModule.counterId('global', 'engine', '2026-09-19'))).toBeUndefined();
});
