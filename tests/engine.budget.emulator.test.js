// Portable, opt-in local integration. No provider calls, global wipes or
// historical working-copy paths. Each run uses its own demo project.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createEngineBudget, COLLECTIONS, counterId, DEFAULT_POLICY} = require('../lib/engineBudget');
const {createEngineBudgetWorker} = require('../lib/engineBudgetWorker');
const {createSpendJournal} = require('../lib/engineBudgetJournal');
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Only a loopback Firestore emulator is permitted');
const suite = host ? describe : describe.skip;
const DAY = '2026-09-19';
const expected = calls => ({physicalCalls: calls, settledCalls: calls, unresolvedCalls: 0,
  knownActualMicrodollars: calls * 32000, uncertainLiabilityMicrodollars: 0, unknownLiabilityCalls: 0});
function gate() {
  let release;
  return {promise: new Promise(resolve => {release = resolve;}), release: () => release()};
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('remote accounting blocked by local journal')), 2000);
    })]);
  } finally {clearTimeout(timer);}
}

suite('real Firestore durable spending observation', () => {
  let db, directory, budgets;
  beforeEach(async () => {
    budgets = [];
    const {Firestore} = require('firebase-admin/firestore');
    db = new Firestore({projectId: `demo-budget-${randomUUID().slice(0, 12)}`, host, ssl: false});
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-emulator-'));
    await db.collection('testWarmup').doc('ready').set({ready: true});
  });
  afterEach(async () => {
    await Promise.all(budgets.map(budget => budget.flushPendingWrites()));
    await db.terminate();
    await fs.rm(directory, {recursive: true, force: true});
  }, 30000);
  const counter = async (scope = 'global', key = 'engine', window = DAY) =>
    (await db.collection(COLLECTIONS.counters).doc(counterId(scope, key, window)).get()).data();
  function observer(overrides = {}) {
    const budget = createEngineBudget({db, journalDirectory: directory, logger: null, now: () => `${DAY}T23:59:59.900Z`,
      policy: {...DEFAULT_POLICY, mode: 'enforce', emergencyStop: true,
        limits: {attemptCalls: 0, attemptMicrodollars: 0, accountDayMicrodollars: 0, globalDayMicrodollars: 0}}, ...overrides});
    budgets.push(budget);
    return budget;
  }
  const begin = (budget, id, user = 'one-user', attempt = 'one-attempt') => budget.beginProviderObservation({
    provider: 'google', rateKey: 'places_search', context: {userId: user, attemptId: attempt}, descriptor: {physicalCallId: id}});
  async function drain(workers, count) {
    for (let i = 0; i < 80; i++) {
      await Promise.all(workers.map(worker => worker.tick()));
      const pending = await db.collection(COLLECTIONS.calls).where('aggregationPending', '==', true).limit(1).get();
      const files = await createSpendJournal({directory}).list();
      if (!pending.size && !files.length && (await counter())?.settledCalls === count) return;
    }
    throw new Error('Accounting failed to converge');
  }

  test('held append fsync permits healthy Firestore receipts; late cleanup failure is recovered exactly once', async () => {
    const held = gate(), originalOpen = fs.open, originalUnlink = fs.unlink;
    let fsyncs = 0;
    const opened = jest.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
      const file = await originalOpen(name, ...args);
      if (String(name).startsWith(directory) && String(name).endsWith('.tmp')) {
        const sync = file.sync.bind(file);
        file.sync = async () => {fsyncs++; await held.promise; return sync();};
      }
      return file;
    });
    const unlink = jest.spyOn(fs, 'unlink').mockImplementation((name, ...args) => {
      if (String(name).startsWith(directory)) return Promise.reject(new Error('cleanup unavailable'));
      return originalUnlink(name, ...args);
    });
    const budget = observer({timeoutMs: 1000});
    try {
      const h = begin(budget, 'held-append');
      const receipts = await bounded(Promise.all([h.markDispatched(), h.settle({result: {}})]));
      expect(receipts.every(r => r.recorded && r.durability === 'firestore')).toBe(true);
      expect((await db.collection(COLLECTIONS.calls).doc(h.id).get()).data()).toMatchObject({state: 'settled'});
      await db.collection('testWarmup').doc('healthy-during-fsync').set({ready: true});
      for (let i = 0; fsyncs < 3 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(fsyncs).toBe(3);
      expect(unlink).not.toHaveBeenCalled();
      held.release();
      await budget.flushPendingWrites();
      expect(budget.getDiagnostics().counts.journal_cleanup_failure).toBe(3);
      expect(await createSpendJournal({directory}).list()).toHaveLength(3);
      unlink.mockRestore();
      const workers = [0, 1].map(() => createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 1}));
      await drain(workers, 1);
      const record = (await db.collection(COLLECTIONS.calls).doc(h.id).get()).data();
      for (const window of [DAY, 'lifetime']) {
        for (const [scope, key] of [['global', 'engine'], ['account', record.owner.key], ['attempt', record.attemptKey]]) {
          expect(await counter(scope, key, window)).toMatchObject(expected(1));
        }
      }
    } finally {held.release(); opened.mockRestore(); unlink.mockRestore(); await budget.flushPendingWrites();}
  }, 30000);

  test.each(['readdir', 'readFile'])('remote aggregation and subsequent ticks survive hung journal %s', async method => {
    const offline = observer({db: null});
    await begin(offline, 'local-only').settle({result: {}});
    await offline.flushPendingWrites();
    const budget = observer({journal: null});
    const first = begin(budget, 'remote-first');
    await first.settle({result: {}});
    await budget.flushPendingWrites();
    const held = gate(), original = fs[method];
    let blocked = 0;
    const operation = jest.spyOn(fs, method).mockImplementation(async (name, ...args) => {
      if (String(name).startsWith(directory)) {blocked++; await held.promise;}
      return original(name, ...args);
    });
    const worker = createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 1, journalTimeoutMs: 20});
    let total = 2;
    try {
      expect((await bounded(worker.tick())).failed).toBe(1);
      expect(await counter()).toMatchObject(expected(1));
      const second = begin(budget, 'remote-second'); total++;
      await second.settle({result: {}});
      await budget.flushPendingWrites();
      for (let i = 0; i < 4; i++) await bounded(worker.tick());
      expect(await counter()).toMatchObject(expected(2));
      expect(blocked).toBe(1);
      expect(worker.getDiagnostics().counts.journal_recovery_timeout).toBe(1);
      await bounded(worker.stop());
    } finally {
      held.release(); operation.mockRestore();
      await drain([worker], total);
      await worker.stop();
    }
    expect(await counter()).toMatchObject(expected(3));
  }, 30000);

  test('three waves of 4 concurrent calls survive restart and aggregate every global/account/attempt window exactly once', async () => {
    const budget = observer(); let physicalCalls = 0; const handles = [];
    // Deliberately no aggregation worker until after all physical calls. This
    // reproduces a restart with durable observations and no in-memory queue.
    for (let wave = 0; wave < 3; wave++) {
      await Promise.all(Array.from({length: 4}, async (_, i) => {
        const h = begin(budget, `${wave}-${i}`, `user-${i % 2}`, `attempt-${i % 2}`); handles.push(h);
        void h.markDispatched(); physicalCalls++;
        await new Promise(resolve => setTimeout(resolve, 10));
        const receipt = await h.settle({result: {}});
        expect(receipt.durability).not.toBe('unconfirmed');
      }));
    }
    expect(physicalCalls).toBe(12);
    await budget.flushPendingWrites();
    expect(await counter()).toBeUndefined();
    const workers = [0, 1].map(() => createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 3}));
    await drain(workers, 12);
    for (const window of [DAY, 'lifetime']) {
      expect(await counter('global', 'engine', window)).toMatchObject(expected(12));
      for (const h of handles.slice(0, 2)) {
        const record = (await db.collection(COLLECTIONS.calls).doc(h.id).get()).data();
        expect(record).toMatchObject({state: 'settled', aggregationPending: false, dispatchDay: DAY});
        expect(await counter('account', record.owner.key, window)).toMatchObject(expected(6));
        expect(await counter('attempt', record.attemptKey, window)).toMatchObject(expected(6));
      }
    }
    // Repeated accounting, including a new handle/process, is not a new call.
    await Promise.all(handles.map(h => h.settle({result: {}})));
    await begin(observer(), '0-0', 'user-0', 'attempt-0').settle({result: {}});
    await Promise.all(budgets.map(b => b.flushPendingWrites()));
    await drain(workers, 12);
    expect(await counter()).toMatchObject(expected(12));
  }, 60000);

  test('settlements race two real workers without lost liability or duplicate sums', async () => {
    const budget = observer();
    const handles = Array.from({length: 8}, (_, i) => begin(budget, `race-${i}`));
    await Promise.all(handles.map(h => h.markDispatched()));
    const workers = [0, 1].map(() => createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 2}));
    await Promise.all([
      ...workers.map(w => w.tick()),
      ...handles.map(h => h.settle({result: {}})),
    ]);
    await budget.flushPendingWrites();
    await drain(workers, 8);
    expect(await counter()).toMatchObject(expected(8));
    const record = (await db.collection(COLLECTIONS.calls).doc(handles[0].id).get()).data();
    expect(await counter('account', record.owner.key)).toMatchObject(expected(8));
    expect(await counter('attempt', record.attemptKey, 'lifetime')).toMatchObject(expected(8));
  }, 60000);
});
