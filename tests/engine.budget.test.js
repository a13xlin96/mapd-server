const {createEngineBudget, COLLECTIONS, DEFAULT_POLICY, DEFAULT_PRICES, counterId, blankCounters, priorDayRisk} = require('../lib/engineBudget');
const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createBudgetHarness} = require('./helpers/engineBudgetHarness');

const copy = value => JSON.parse(JSON.stringify(value));
const DAY = '2026-09-18';
const NOW = `${DAY}T23:59:58.000Z`;
const ctx = {verifiedUID: 'account-a', attemptId: 'attempt-a'};
const textDescriptor = {maxInputTokens: 1000, maxImageTokens: 0, maxOutputTokens: 200, cacheEnabled: false};
const usage = (input = 100, output = 20) => ({usage: {input_tokens: input, output_tokens: output,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0}});

function setup(options = {}) {
  const db = new FakeFirestore(); db.strictReadOrder = true;
  const logger = {warn: jest.fn()};
  let time = NOW;
  const budget = createBudgetHarness({db, logger, now: () => time, ...options});
  const begin = (args = {}) => budget.beginProviderObservation({provider: 'google', stage: 'matching',
    rateKey: 'places_search', context: ctx, ...args});
  const row = handle => db.read(COLLECTIONS.calls, handle.id);
  const counters = (scope = 'global', window = DAY, key = 'engine') =>
    db.read(COLLECTIONS.counters, counterId(scope, key, window));
  return {db, logger, budget, begin, row, counters, setTime: value => { time = value; }};
}

async function paid(handle, result = {}) {
  await handle.markDispatched();
  await handle.settle({result, dispatched: true});
  return result;
}

describe('fixed observation runtime', () => {
  test.each([
    {policy: {...DEFAULT_POLICY, mode: 'enforce', emergencyStop: true,
      limits: {attemptCalls: 0, attemptMicrodollars: 0, accountDayMicrodollars: 0, globalDayMicrodollars: 0}}},
    {policy: null}, {policy: {limits: 'broken'}}, {prices: null}, {prices: {rates: 'broken'}},
    {prices: {...DEFAULT_PRICES, rates: {}}}, {db: null}, {db: {}},
    {db: {collection() { throw new Error('secret credential'); }, runTransaction() {}}},
    {getDb() { throw new Error('secret credential'); }},
    {db: {collection() { return {doc() { return {}; }}; }, runTransaction() { return Promise.reject(new Error('secret credential')); }}},
  ])('missing/broken ledger/rates/caps never stop paid work: %j', async options => {
    const s = setup(options);
    const handle = s.begin();
    expect(typeof handle.id).toBe('string');
    expect(typeof handle.then).toBe('undefined');
    const provider = jest.fn().mockResolvedValue({data: {ok: true}});
    await expect(handle.markDispatched()).resolves.toMatchObject({mode: 'observe'});
    const result = await provider();
    await expect(handle.settle({result, dispatched: true})).resolves.toMatchObject({mode: 'observe'});
    await expect(handle.releaseUnsent()).resolves.toMatchObject({mode: 'observe'});
    expect(provider).toHaveBeenCalledTimes(1);
    expect(s.budget.mode).toBe('observe');
    expect(JSON.stringify(s.logger.warn.mock.calls)).not.toContain('secret credential');
  });

  test('environment enforcement switches cannot activate spending/request limits', async () => {
    const previous = process.env.ENGINE_BUDGET_MODE;
    process.env.ENGINE_BUDGET_MODE = 'enforce';
    try {
      const s = setup();
      await Promise.all(Array.from({length: 5}, () => paid(s.begin())));
      expect(s.counters().physicalCalls).toBe(5);
      expect(s.budget.mode).toBe('observe');
    } finally {
      if (previous === undefined) delete process.env.ENGINE_BUDGET_MODE;
      else process.env.ENGINE_BUDGET_MODE = previous;
    }
  });

  test('hung ledger operations have a bounded wait, and late failures cannot reject work', async () => {
    let reject;
    const s = setup({timeoutMs: 5, db: {collection: () => ({doc: () => ({})}),
      runTransaction: () => new Promise((resolve, fail) => { reject = fail; })}});
    const h = s.begin();
    await expect(h.markDispatched()).resolves.toMatchObject({recorded: false, reason: 'ledger_timeout'});
    reject(new Error('late secret'));
    await expect(h.settle({result: {}})).resolves.toMatchObject({recorded: false, reason: 'ledger_timeout'});
    expect(s.budget.getDiagnostics().counts.ledger_timeout).toBeGreaterThanOrEqual(2);
  });

  test('malformed observation/getters and broken async logging do not reject', async () => {
    const s = setup({logger: {warn() { return Promise.reject(new Error('broken logger')); }}});
    const h = s.begin({descriptor: {get maxInputTokens() { throw new Error('private text'); }}});
    await expect(h.markDispatched()).resolves.toMatchObject({recorded: false});
    await expect(h.settle()).resolves.toMatchObject({recorded: false});
    const valid = s.begin();
    await expect(valid.settle({get result() { throw new Error('private text'); }})).resolves.toMatchObject({recorded: false});
  });
});

describe('physical call ledger and safe attribution', () => {
  test('one successful Google call charges global/account/attempt once; dimensions are not additive', async () => {
    const s = setup(); const h = s.begin();
    await h.markDispatched();
    expect(s.row(h)).toMatchObject({state: 'dispatched', actualMicrodollars: null,
      ceilingMicrodollars: 32000, uncertainLiabilityMicrodollars: 32000});
    await h.settle({result: {data: {places: []}}, dispatched: true});
    const record = s.row(h);
    expect(record).toMatchObject({state: 'settled', actualMicrodollars: 32000, knownActualMicrodollars: 32000,
      dispatchDay: DAY, priceVersion: 'audit-2026-09-18', priceAsOf: DAY, uncertainLiabilityMicrodollars: 0});
    for (const [scope, key] of [['global', 'engine'], ['account', record.owner.key], ['attempt', record.attemptKey]]) {
      for (const window of [DAY, 'lifetime']) expect(s.counters(scope, window, key)).toMatchObject({physicalCalls: 1,
        knownActualMicrodollars: 32000, uncertainLiabilityMicrodollars: 0, unresolvedCalls: 0, settledCalls: 1});
    }
  });

  test('trusted userId/jobId compatibility and named service callers share the global total', async () => {
    const s = setup();
    const a = s.begin({context: {userId: 'same-user', jobId: 'job-1'}});
    const b = s.begin({context: {verifiedUID: 'same-user', attemptId: 'job-1'}});
    const service = s.begin({context: {serviceIdentity: 'details-worker', attemptId: 'backfill-1'}});
    const missing = s.begin({context: {body: {userId: 'forged'}, accountId: 'forged'}});
    await Promise.all([a, b, service, missing].map(h => paid(h)));
    expect(s.row(a).owner).toEqual(s.row(b).owner);
    expect(s.row(a).attemptKey).toEqual(s.row(b).attemptKey);
    expect(s.counters('account', DAY, s.row(a).owner.key).physicalCalls).toBe(2);
    expect(s.row(service).owner.kind).toBe('service');
    expect(s.row(missing).diagnostics).toContain('missing_trusted_identity');
    expect(s.counters().physicalCalls).toBe(4);
  });

  test('verified UID wins over trusted fallback and no raw content/secrets enter ledger or diagnostics', async () => {
    const s = setup();
    const h = s.begin({context: {verifiedUID: 'verified-private', userId: 'fallback', attemptId: 'secret-attempt',
      body: {userId: 'forged-private', caption: 'private caption'}},
    descriptor: {physicalCallId: 'secret-request-id', prompt: 'private prompt', apiKey: 'private key'}});
    await h.markDispatched();
    await h.settle({result: {data: 'private response'}, error: new Error('private error'), dispatched: true});
    const persisted = JSON.stringify([...s.db.collections].map(([name, map]) => [name, [...map]]));
    for (const secret of ['verified-private', 'fallback', 'forged-private', 'secret-attempt', 'secret-request-id',
      'private caption', 'private prompt', 'private key', 'private response', 'private error']) {
      expect(persisted).not.toContain(secret);
      expect(JSON.stringify(s.logger.warn.mock.calls)).not.toContain(secret);
    }
  });

  test('factory injects current context; cache hits/followers doing no wrapper create no spend', async () => {
    const s = setup({getContext: () => ({userId: 'middleware-user', jobId: 'compat-job'})});
    expect(s.db.collections.size).toBe(0);
    const h = s.begin({context: undefined}); await paid(h);
    expect(s.row(h).owner.kind).toBe('account');
    expect(s.row(h).diagnostics).not.toContain('missing_attempt_identity');
    expect(s.counters().physicalCalls).toBe(1);
  });
});

describe('actual usage, conservative ceilings and unknown liability', () => {
  test('Haiku actual reported usage releases excess but missing usage retains the ceiling', async () => {
    const s = setup();
    const a = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await paid(a, usage());
    expect(s.row(a)).toMatchObject({ceilingMicrodollars: 2000, actualMicrodollars: 200,
      knownActualMicrodollars: 200, usage: {input: 100, output: 20}, uncertainLiabilityMicrodollars: 0});
    const b = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await paid(b, {});
    expect(s.row(b)).toMatchObject({state: 'uncertain', actualMicrodollars: null, uncertainLiabilityMicrodollars: 2000});
    expect(s.counters()).toMatchObject({knownActualMicrodollars: 200, uncertainLiabilityMicrodollars: 2000, unresolvedCalls: 1});
  });

  test('partial usage books only the known component plus remaining liability, never double-counting it', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await paid(h, {usage: {input_tokens: 100}});
    expect(s.row(h)).toMatchObject({actualMicrodollars: null, knownActualMicrodollars: 100, uncertainLiabilityMicrodollars: 1900});
    await h.settle({result: usage(100, 20)});
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200, uncertainLiabilityMicrodollars: 0, unresolvedCalls: 0});
  });

  test('parent inputBytes/imageTokens descriptors produce a conservative bound with framing allowance', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku',
      descriptor: {inputBytes: 1000, imageTokens: 2000, maxOutputTokens: 200, cacheEnabled: false}});
    await h.markDispatched();
    expect(s.row(h).ceilingMicrodollars).toBe(5024);
    expect(s.row(h).descriptor).toEqual({maxInputTokens: 2024, maxImageTokens: 2000, maxOutputTokens: 200, cacheEnabled: false});
  });

  test('unpriced or incomplete cache usage stays unknown; known zero usage is explicitly zero', async () => {
    const s = setup();
    const unknown = s.begin({provider: 'anthropic', rateKey: 'haiku'});
    await paid(unknown, {usage: {input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0}});
    expect(s.row(unknown)).toMatchObject({actualMicrodollars: null, knownActualMicrodollars: 200,
      uncertainLiabilityMicrodollars: null, unknownLiability: true});
    const zero = s.begin({provider: 'anthropic', rateKey: 'haiku'});
    await paid(zero, usage(0, 0));
    expect(s.row(zero)).toMatchObject({actualMicrodollars: 0, unknownLiability: false});
    expect(s.counters().unknownLiabilityCalls).toBe(1);
  });

  test('unexpected unpriced cache usage cannot retain a misleading finite ceiling', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await paid(h, {usage: {...usage().usage, cache_read_input_tokens: 100}});
    expect(s.row(h)).toMatchObject({actualMicrodollars: null, knownActualMicrodollars: 200,
      uncertainLiabilityMicrodollars: null, unknownLiability: true});
    expect(s.row(h).diagnostics).toContain('cache_descriptor_mismatch');
    expect(s.counters().unknownLiabilityCalls).toBe(1);
  });

  test.each([
    {provider: 'anthropic', rateKey: 'not-configured', descriptor: textDescriptor},
    {provider: 'google', rateKey: 'haiku'},
    {provider: 'anthropic', rateKey: 'haiku', descriptor: {...textDescriptor, model: 'different-model'}},
  ])('unknown/mismatched SKU is not zero: %j', async args => {
    const s = setup(); const h = s.begin(args); await paid(h, usage());
    expect(s.row(h)).toMatchObject({actualMicrodollars: null, ceilingMicrodollars: null, unknownLiability: true});
    expect(s.counters().unknownLiabilityCalls).toBe(1);
  });

  test('failure after dispatch holds the Google fee; released/false/missing usage cannot refund', async () => {
    const s = setup(); const h = s.begin();
    await h.markDispatched();
    await h.settle({error: new Error('timeout'), dispatched: true});
    await h.releaseUnsent();
    await h.settle({dispatched: false});
    expect(s.row(h)).toMatchObject({state: 'uncertain', actualMicrodollars: null, uncertainLiabilityMicrodollars: 32000});
    expect(s.counters()).toMatchObject({physicalCalls: 1, uncertainLiabilityMicrodollars: 32000});
  });

  test('reported usage in a failed response can settle; more than the bound is recorded without blocking', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await h.markDispatched();
    await expect(h.settle({error: {usage: usage(5000, 1000).usage}})).resolves.toMatchObject({recorded: true});
    expect(s.row(h)).toMatchObject({actualMicrodollars: 10000, ceilingBreached: true, unknownLiability: false});
    expect(s.row(h).diagnostics).toContain('ceiling_exceeded');
  });

  test('stale price date at dispatch is unknown and never blocks', async () => {
    const prices = {...copy(DEFAULT_PRICES), validThrough: DAY};
    const s = setup({prices}); const h = s.begin();
    s.setTime('2026-09-19T00:00:01.000Z');
    await paid(h);
    expect(s.row(h)).toMatchObject({dispatchDay: '2026-09-19', actualMicrodollars: null});
    expect(s.row(h).diagnostics).toContain('stale_prices');
  });
});

describe('atomic idempotency, recovery and UTC rollover', () => {
  test('independent clients concurrently accounting the same physical id settle exactly once', async () => {
    const s = setup();
    const clients = Array.from({length: 12}, () => createEngineBudget({db: s.db, journal: null, logger: null, now: () => NOW}));
    const handles = clients.map(client => client.beginProviderObservation({provider: 'anthropic', rateKey: 'haiku', context: ctx,
      descriptor: {...textDescriptor, physicalCallId: 'same-physical-call'}}));
    await Promise.all(handles.map(h => h.markDispatched()));
    await Promise.all(handles.flatMap(h => [h.settle({result: usage()}), h.settle({result: usage()}), h.releaseUnsent()]));
    await s.budget.drain();
    expect(new Set(handles.map(h => h.id)).size).toBe(1);
    expect(s.db.collections.get(COLLECTIONS.calls).size).toBe(1);
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200,
      uncertainLiabilityMicrodollars: 0, settledCalls: 1});
  });

  test('all independent physical calls across endpoints/accounts sum without lost updates', async () => {
    const s = setup();
    const handles = Array.from({length: 20}, (_, i) => s.begin({context: {userId: `user-${i % 2}`, jobId: `job-${i % 4}`}}));
    await Promise.all(handles.map(h => paid(h)));
    expect(s.counters()).toMatchObject({physicalCalls: 20, knownActualMicrodollars: 640000});
    expect(s.counters('account', DAY, s.row(handles[0]).owner.key).physicalCalls).toBe(10);
  });

  test('a transaction callback replay has no external side effects or duplicate charge', async () => {
    const s = setup(); const original = s.db.runTransaction.bind(s.db);
    s.db.runTransaction = async callback => {
      await original(async tx => { await callback(tx); throw new Error('simulated retry'); }).catch(() => {});
      return original(callback);
    };
    const h = s.begin(); await paid(h);
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 32000});
  });

  test('commit response loss/retry does not duplicate a charge', async () => {
    const s = setup(); const original = s.db.runTransaction.bind(s.db); let lose = true;
    s.db.runTransaction = async callback => {
      const result = await original(callback);
      if (lose) { lose = false; throw new Error('ack lost after commit'); }
      return result;
    };
    const h = s.begin(); await paid(h); await h.settle({result: {}});
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 32000});
  });

  test('duplicate final settlement cannot reduce/increase cost or refund into a new day', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku', descriptor: textDescriptor});
    await paid(h, usage());
    s.setTime('2026-09-19T01:00:00.000Z');
    await h.settle({result: usage(0, 0)});
    await h.settle({result: usage(500, 500)});
    await h.releaseUnsent();
    expect(s.row(h).actualMicrodollars).toBe(200);
    expect(s.row(h).diagnostics).toContain('settlement_conflict');
    expect(s.counters('global', '2026-09-19')).toBeUndefined();
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 200});
  });

  test('prepared calls cross midnight without accruing yesterday, dispatched calls never change windows', async () => {
    const s = setup(); const prepared = s.begin(); const old = s.begin();
    await old.markDispatched();
    s.setTime('2026-09-19T00:00:01.000Z');
    await prepared.markDispatched();
    expect(s.row(prepared).dispatchDay).toBe('2026-09-19');
    expect(s.row(old).dispatchDay).toBe(DAY);
    expect(s.counters().physicalCalls).toBe(1);
    expect(s.counters('global', '2026-09-19').physicalCalls).toBe(1);
    expect(priorDayRisk(s.counters('global', 'lifetime'), s.counters('global', '2026-09-19')))
      .toEqual({priorDayRiskMicrodollars: 32000, priorDayUnknownLiabilityCalls: 0});
    await old.settle({result: {}});
    await old.settle({result: {}});
    expect(s.counters()).toMatchObject({knownActualMicrodollars: 32000, uncertainLiabilityMicrodollars: 0});
    expect(s.counters('global', '2026-09-19')).toMatchObject({knownActualMicrodollars: 0, uncertainLiabilityMicrodollars: 32000});
    expect(priorDayRisk(s.counters('global', 'lifetime'), s.counters('global', '2026-09-19')).priorDayRiskMicrodollars).toBe(0);
  });

  test('fire-and-forget dispatch persistence delayed/retried past midnight retains the observed dispatch day', async () => {
    const s = setup(); const original = s.db.runTransaction.bind(s.db); let calls = 0;
    s.db.runTransaction = async callback => {
      calls++;
      if (calls === 2) {
        await original(async tx => { await callback(tx); throw new Error('retry across midnight'); }).catch(() => {});
        s.setTime('2026-09-19T00:00:01.000Z');
      }
      return original(callback);
    };
    const h = s.begin(); await paid(h);
    expect(s.row(h).dispatchDay).toBe(DAY);
    expect(s.counters('global', '2026-09-19')).toBeUndefined();
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 32000});
  });

  test('cross-day unknown liability risk is released only by reconciliation on its original day', async () => {
    const s = setup(); const h = s.begin({provider: 'anthropic', rateKey: 'haiku'});
    await h.markDispatched();
    s.setTime('2026-09-19T00:00:01.000Z');
    const current = s.begin(); await current.markDispatched();
    expect(priorDayRisk(s.counters('global', 'lifetime'), s.counters('global', '2026-09-19')).priorDayUnknownLiabilityCalls).toBe(1);
    await h.settle({result: usage()}); await h.settle({result: usage()});
    expect(priorDayRisk(s.counters('global', 'lifetime'), s.counters('global', '2026-09-19')).priorDayUnknownLiabilityCalls).toBe(0);
    expect(s.counters()).toMatchObject({knownActualMicrodollars: 200, unknownLiabilityCalls: 0});
    expect(s.counters('global', '2026-09-19')).toMatchObject({knownActualMicrodollars: 0, uncertainLiabilityMicrodollars: 32000});
  });

  test('failed dispatch storage recovered by settlement still uses original UTC dispatch day', async () => {
    const s = setup(); s.db.setWriteFailure(() => new Error('outage'));
    const h = s.begin(); await h.markDispatched();
    s.setTime('2026-09-19T00:00:01.000Z'); s.db.setWriteFailure(null);
    await h.settle({result: {}});
    expect(s.row(h).dispatchDay).toBe(DAY);
    expect(s.counters().knownActualMicrodollars).toBe(32000);
    expect(s.counters('global', '2026-09-19')).toBeUndefined();
  });

  test('settlement uses durable price version after restart even when configured rates change', async () => {
    const s = setup(); const descriptor = {physicalCallId: 'old-dispatch'};
    const h = s.begin({descriptor}); await h.markDispatched();
    const prices = copy(DEFAULT_PRICES); prices.version = 'new-version'; prices.rates.places_search.microdollarsPerCall = 99999;
    const restarted = createBudgetHarness({db: s.db, logger: null, now: () => '2026-09-19T01:00:00.000Z', prices});
    const recovered = restarted.beginProviderObservation({provider: 'google', rateKey: 'places_search', context: ctx, descriptor});
    await recovered.settle({result: {}});
    expect(s.row(h)).toMatchObject({actualMicrodollars: 32000, priceVersion: 'audit-2026-09-18', dispatchDay: DAY});
  });

  test('proven unsent work is idempotently released with no physical call; later observed dispatch is charged', async () => {
    const s = setup(); const h = s.begin();
    await h.releaseUnsent(); await h.releaseUnsent(); await h.settle({dispatched: false});
    expect(s.row(h).state).toBe('released');
    expect(s.counters()).toBeUndefined();
    await paid(h);
    expect(s.counters()).toMatchObject({physicalCalls: 1, knownActualMicrodollars: 32000});
    expect(s.row(h).diagnostics).toContain('dispatch_after_release');
  });

  test('same id for a different account is diagnostic, not a rewrite or a runtime denial', async () => {
    const s = setup(); const descriptor = {physicalCallId: 'collision'};
    const a = s.begin({descriptor}); await paid(a);
    const b = s.begin({descriptor, context: {verifiedUID: 'other', attemptId: 'attempt-a'}});
    await expect(b.markDispatched()).resolves.toMatchObject({recorded: false, reason: 'identity_or_schema_conflict'});
    expect(s.counters().physicalCalls).toBe(1);
  });

  test('missing/corrupt counters cannot create negative liability or a second refund', async () => {
    const s = setup(); const h = s.begin(); await h.markDispatched();
    const id = counterId('global', 'engine', DAY);
    s.db.collections.get(COLLECTIONS.counters).delete(id);
    await expect(h.settle({result: {}})).resolves.toMatchObject({recorded: true});
    expect(s.row(h)).toMatchObject({state: 'settled', aggregationPending: true});
    s.db.seed(COLLECTIONS.counters, id, {schemaVersion: 1, scope: 'global', key: 'engine', window: DAY,
      ...blankCounters(), uncertainLiabilityMicrodollars: -1});
    await expect(h.settle({result: {}})).resolves.toMatchObject({recorded: true});
    expect(s.row(h)).toMatchObject({actualMicrodollars: 32000, aggregationPending: true});
  });
});
