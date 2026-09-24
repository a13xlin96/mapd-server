const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createEngineBudget, COLLECTIONS, counterId, aggregateCall} = require('../lib/engineBudget');
const {createEngineBudgetWorker} = require('../lib/engineBudgetWorker');
const {createSpendJournal} = require('../lib/engineBudgetJournal');
const {FakeFirestore} = require('./helpers/fakeFirestore');

const DAY = '2026-09-19';
const now = () => `${DAY}T23:59:59.999Z`;
const input = (id = 'physical-call') => ({provider: 'google', rateKey: 'places_search',
  descriptor: {physicalCallId: id, url: 'https://private.invalid/source'},
  context: {userId: 'private-user', attemptId: 'private-attempt'}});
const getCounter = db => db.read(COLLECTIONS.counters, counterId('global', 'engine', DAY));
const stored = db => JSON.stringify([...db.collections].map(([key, rows]) => [key, [...rows]]));
let directory;
beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-worker-'));});
afterEach(async () => {await fs.rm(directory, {recursive: true, force: true});});
async function drain(worker, db, journal = null) {
  for (let i = 0; i < 40; i++) {
    await worker.tick();
    const pending = await db.collection(COLLECTIONS.calls).where('aggregationPending', '==', true).limit(1).get();
    if (!pending.size && (!journal || !(await journal.list()).length)) return;
    // A timed-out recovery batch continues independently between ticks.
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('durable accounting did not drain');
}

function gate() {
  let release;
  return {promise: new Promise(resolve => {release = resolve;}), release: () => release()};
}
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('expected asynchronous accounting progress');
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('accounting remained blocked')), 1000);
    })]);
  } finally {clearTimeout(timer);}
}

test.each(['writeFile', 'sync', 'directory sync'])('healthy remote receipts do not wait for journal %s, and late files are cleaned', async operation => {
  const held = gate(), originalOpen = fs.open;
  let heldCalls = 0;
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
    const file = await originalOpen(name, ...args);
    if (operation === 'directory sync' ? name === directory : String(name).startsWith(directory) && String(name).endsWith('.tmp')) {
      const method = operation === 'writeFile' ? 'writeFile' : 'sync';
      const original = file[method].bind(file);
      file[method] = async (...values) => {heldCalls++; await held.promise; return original(...values);};
    }
    return file;
  });
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journalDirectory: directory, timeoutMs: 25, logger: null, now});
  try {
    const h = budget.beginProviderObservation(input());
    const receipts = await Promise.all([h.markDispatched(), h.settle({result: {}})]);
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({recorded: true, durability: 'firestore', reason: null, state: 'dispatched'}),
      expect.objectContaining({recorded: true, durability: 'firestore', reason: null, state: 'settled'}),
    ]));
    await eventually(() => heldCalls === 3);
    expect(db.read(COLLECTIONS.calls, h.id).state).toBe('settled');
    let flushed = false;
    const flushing = budget.flushPendingWrites().then(() => {flushed = true;});
    await new Promise(resolve => setImmediate(resolve));
    expect(flushed).toBe(false);
    held.release();
    await flushing;
    expect(await createSpendJournal({directory}).list()).toEqual([]);
    await drain(createEngineBudgetWorker({db, journal: null, logger: null}), db);
    expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000});
  } finally {held.release(); opened.mockRestore(); await budget.flushPendingWrites();}
});

test('hung cleanup cannot delay remote receipts or later transitions', async () => {
  const held = gate(), originalUnlink = fs.unlink;
  let removals = 0;
  const unlink = jest.spyOn(fs, 'unlink').mockImplementation(async (name, ...args) => {
    if (String(name).startsWith(directory)) {removals++; await held.promise;}
    return originalUnlink(name, ...args);
  });
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journalDirectory: directory, timeoutMs: 25, logger: null, now});
  try {
    const h = budget.beginProviderObservation(input());
    expect(await h.markDispatched()).toMatchObject({recorded: true, durability: 'firestore'});
    expect(await h.settle({result: {}})).toMatchObject({recorded: true, durability: 'firestore', state: 'settled'});
    await eventually(() => removals === 3);
    expect(await createSpendJournal({directory}).list()).toHaveLength(3);
    expect(await h.releaseUnsent()).toMatchObject({recorded: true, state: 'settled'});
  } finally {held.release(); unlink.mockRestore(); await budget.flushPendingWrites();}
  expect(await createSpendJournal({directory}).list()).toEqual([]);
});

test('failed cleanup after a late append is retried from disk without duplicate charges', async () => {
  const held = gate(), originalOpen = fs.open;
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
    const file = await originalOpen(name, ...args);
    if (String(name).startsWith(directory) && String(name).endsWith('.tmp')) {
      const sync = file.sync.bind(file);
      file.sync = async () => {await held.promise; return sync();};
    }
    return file;
  });
  const unlink = jest.spyOn(fs, 'unlink').mockRejectedValue(new Error('temporary cleanup outage'));
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journalDirectory: directory, timeoutMs: 25, logger: null, now});
  try {
    const h = budget.beginProviderObservation(input());
    void h.markDispatched();
    expect(await h.settle({result: {}})).toMatchObject({recorded: true, durability: 'firestore'});
    expect(unlink).not.toHaveBeenCalled();
    await aggregateCall(db, h.id);
    held.release();
    await budget.flushPendingWrites();
    expect(budget.getDiagnostics().counts.journal_cleanup_failure).toBe(3);
    const journal = createSpendJournal({directory});
    expect(await journal.list()).toHaveLength(3);
    unlink.mockRestore();
    await drain(createEngineBudgetWorker({db, journalDirectory: directory, logger: null}), db, journal);
    expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000});
  } finally {held.release(); opened.mockRestore(); unlink.mockRestore(); await budget.flushPendingWrites();}
});

test.each(['file', 'directory'])('unconfirmed receipts retain late %s fsync writes for recovery after remote failure', async kind => {
  const held = gate(), originalOpen = fs.open;
  let syncs = 0;
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
    const file = await originalOpen(name, ...args);
    if (kind === 'directory' ? name === directory : String(name).startsWith(directory) && String(name).endsWith('.tmp')) {
      const sync = file.sync.bind(file);
      file.sync = async () => {syncs++; await held.promise; return sync();};
    }
    return file;
  });
  const budget = createEngineBudget({db: null, journalDirectory: directory, timeoutMs: 25, logger: null, now});
  try {
    const h = budget.beginProviderObservation(input());
    void h.markDispatched();
    expect(await bounded(h.settle({result: {}}))).toMatchObject({recorded: false, durability: 'unconfirmed', pending: false});
    await eventually(() => syncs === 3);
    let flushed = false;
    const flushing = budget.flushPendingWrites().then(() => {flushed = true;});
    await new Promise(resolve => setImmediate(resolve));
    expect(flushed).toBe(false);
    held.release(); await flushing;
    const journal = createSpendJournal({directory});
    expect(await journal.list()).toHaveLength(3);
    const db = new FakeFirestore();
    await drain(createEngineBudgetWorker({db, journalDirectory: directory, logger: null}), db, journal);
    expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000});
  } finally {held.release(); opened.mockRestore(); await budget.flushPendingWrites();}
});

test.each(['readdir', 'readFile', 'unlink'])('hung journal %s permits bounded ticks, remote progress and safe late recovery', async method => {
  const offline = createEngineBudget({db: null, journalDirectory: directory, logger: null, now});
  await offline.beginProviderObservation(input('local-only')).settle({result: {}});
  await offline.flushPendingWrites();
  const held = gate(), original = fs[method];
  let blocked = 0;
  const operation = jest.spyOn(fs, method).mockImplementation(async (name, ...args) => {
    if (String(name).startsWith(directory)) {blocked++; await held.promise;}
    return original(name, ...args);
  });
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journal: null, logger: null, now});
  const worker = createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 1, journalTimeoutMs: 10});
  try {
    const first = budget.beginProviderObservation(input('remote-one'));
    await first.settle({result: {}});
    const tick = worker.tick();
    expect(worker.tick()).toBe(tick);
    expect((await bounded(tick)).failed).toBe(1);
    expect(db.read(COLLECTIONS.calls, first.id).aggregationPending).toBe(false);
    expect(blocked).toBe(1);
    const second = budget.beginProviderObservation(input('remote-two'));
    await second.settle({result: {}});
    for (let i = 0; i < 4; i++) await bounded(worker.tick());
    expect(db.read(COLLECTIONS.calls, second.id).aggregationPending).toBe(false);
    expect(blocked).toBe(1);
    expect(worker.getDiagnostics().counts.journal_recovery_timeout).toBe(1);
    await bounded(worker.stop());
    held.release(); operation.mockRestore();
    await drain(worker, db, createSpendJournal({directory}));
    expect(getCounter(db)).toMatchObject({physicalCalls: 3, settledCalls: 3, knownActualMicrodollars: 96000});
  } finally {
    held.release(); operation.mockRestore();
    await budget.flushPendingWrites();
    await drain(worker, db, createSpendJournal({directory}));
    await worker.stop();
  }
});

test('concurrent observation transitions never read or write common counters', async () => {
  const db = new FakeFirestore(); db.strictReadOrder = true;
  db.setTxnReadHook(ref => {if (ref.collection === COLLECTIONS.counters) throw new Error('hot counter on call path');});
  const budget = createEngineBudget({db, journal: null, logger: null, now});
  const receipts = await Promise.all(Array.from({length: 8}, async (_, i) => {
    const h = budget.beginProviderObservation(input(`call-${i}`));
    void h.markDispatched();
    return h.settle({result: {}});
  }));
  expect(receipts.every(r => r.recorded)).toBe(true);
  expect(db.collections.has(COLLECTIONS.counters)).toBe(false);
  expect((await db.collection(COLLECTIONS.calls).get()).docs.every(d => d.data().aggregationPending)).toBe(true);
  db.setTxnReadHook(null);
  await drain(createEngineBudgetWorker({db, journal: null, logger: null, batchSize: 2}), db);
  expect(getCounter(db)).toMatchObject({physicalCalls: 8, settledCalls: 8, knownActualMicrodollars: 256000});
});

test('initial database outage is recoverable after process exit, including dispatch and final usage', async () => {
  const modulePath = path.resolve(__dirname, '../lib/engineBudget');
  const script = `
    const {createEngineBudget}=require(process.argv[1]);
    const budget=createEngineBudget({journalDirectory:process.argv[2],logger:null,now:()=>${JSON.stringify(now())},
      db:{collection:()=>({doc:()=>({})}),runTransaction:async()=>{throw new Error('private database URL');}}});
    (async()=>{
      const h=budget.beginProviderObservation(${JSON.stringify(input())});
      void h.markDispatched();
      const receipt=await h.settle({result:{privateUrl:'https://private.invalid/result'}});
      process.stdout.write(JSON.stringify(receipt));
    })();
  `;
  const receipt = JSON.parse(execFileSync(process.execPath, ['-e', script, modulePath, directory], {encoding: 'utf8', timeout: 5000}));
  expect(receipt).toMatchObject({recorded: false, durability: 'local', pending: true, reason: 'ledger_failure'});
  const journal = createSpendJournal({directory});
  const names = await journal.list();
  expect(names).toHaveLength(3);
  const text = (await Promise.all(names.map(name => fs.readFile(path.join(directory, name), 'utf8')))).join('');
  for (const secret of ['https://', 'private-user', 'private-attempt', 'physical-call', 'private database URL']) expect(text).not.toContain(secret);
  const db = new FakeFirestore();
  // Fresh process state: no original handle, queue, callbacks or timestamps.
  await drain(createEngineBudgetWorker({db, journalDirectory: directory, logger: null, batchSize: 1}), db, journal);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000});
  expect(db.read(COLLECTIONS.calls, receipt.id)).toMatchObject({state: 'settled', dispatchDay: DAY, aggregationPending: false});
  expect(await journal.list()).toEqual([]);
});

test('database and journal failure never claim a durable pending record; log no raw error', async () => {
  const file = path.join(directory, 'not-a-directory'); await fs.writeFile(file, '');
  const logger = {warn: jest.fn()};
  const budget = createEngineBudget({db: null, journalDirectory: file, logger, now});
  const h = budget.beginProviderObservation(input());
  expect(await h.settle({result: {}})).toMatchObject({recorded: false, durability: 'unconfirmed', pending: false});
  expect(budget.getDiagnostics().counts.journal_unavailable).toBeGreaterThan(0);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(file);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('https://');
});

test('journal failure can still produce an honest Firestore receipt', async () => {
  const file = path.join(directory, 'file'); await fs.writeFile(file, '');
  const db = new FakeFirestore();
  const h = createEngineBudget({db, journalDirectory: file, logger: null, now}).beginProviderObservation(input());
  expect(await h.settle({result: {}})).toMatchObject({recorded: true, durability: 'firestore'});
  expect(db.read(COLLECTIONS.calls, h.id).aggregationPending).toBe(true);
});

test('a timed out database write remains recoverable and a late commit cannot duplicate it', async () => {
  const db = new FakeFirestore();
  const original = db.runTransaction.bind(db);
  let release;
  const barrier = new Promise(resolve => {release = resolve;});
  db.runTransaction = async (callback, options) => {await barrier; return original(callback, options);};
  const budget = createEngineBudget({db, journalDirectory: directory, timeoutMs: 25, logger: null, now});
  const h = budget.beginProviderObservation(input());
  void h.markDispatched();
  expect(await h.settle({result: {}})).toMatchObject({recorded: false, pending: true, durability: 'local', reason: 'ledger_timeout'});
  db.runTransaction = original;
  const journal = createSpendJournal({directory});
  const worker = createEngineBudgetWorker({db, journalDirectory: directory, logger: null});
  await drain(worker, db, journal);
  release();
  await budget.flushPendingWrites();
  await drain(worker, db, journal);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000});
});

test('two workers and a lost aggregation acknowledgement still apply each contribution exactly once', async () => {
  const db = new FakeFirestore(); db.strictReadOrder = true;
  const h = createEngineBudget({db, journal: null, logger: null, now}).beginProviderObservation(input());
  await h.markDispatched();
  const original = db.runTransaction.bind(db); let lost = true;
  db.runTransaction = async (callback, options) => {
    const value = await original(callback, options);
    if (lost) {lost = false; throw new Error('commit ack lost');}
    return value;
  };
  const a = createEngineBudgetWorker({db, journal: null, logger: null});
  const b = createEngineBudgetWorker({db, journal: null, logger: null});
  await Promise.all([a.tick(), b.tick(), a.tick()]);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, unresolvedCalls: 1, uncertainLiabilityMicrodollars: 32000});
  await h.settle({result: {}});
  await Promise.all([drain(a, db), drain(b, db)]);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, unresolvedCalls: 0,
    knownActualMicrodollars: 32000, uncertainLiabilityMicrodollars: 0});
});

test('failed aggregation is durable, bounded per tick, and cannot starve a later call', async () => {
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journal: null, logger: null, now});
  const handles = [budget.beginProviderObservation(input('one')), budget.beginProviderObservation(input('two'))];
  await Promise.all(handles.map(h => h.settle({result: {}})));
  const first = handles.map(h => h.id).sort()[0];
  let failedAttempts = 0;
  const original = db.runTransaction.bind(db);
  db.runTransaction = (callback, options) => {
    expect(options.maxAttempts).toBe(5);
    return original(callback);
  };
  db.setTxnReadHook(ref => {
    if (ref.collection === COLLECTIONS.calls && ref.id === first) {failedAttempts++; throw new Error('unavailable');}
  });
  const worker = createEngineBudgetWorker({db, journal: null, logger: null, batchSize: 1});
  expect((await worker.tick()).failed).toBe(1);
  expect(failedAttempts).toBe(1);
  expect((await worker.tick()).aggregated).toBe(1);
  expect(getCounter(db).physicalCalls).toBe(1);
  expect(db.read(COLLECTIONS.calls, first).aggregationPending).toBe(true);
  db.setTxnReadHook(null);
  // Recovery after restart discovers the still-pending first record.
  await drain(createEngineBudgetWorker({db, journal: null, logger: null}), db);
  expect(getCounter(db).physicalCalls).toBe(2);
});

test('upgrading an old dispatched record preserves already-booked liability', async () => {
  const db = new FakeFirestore();
  const h = createEngineBudget({db, journal: null, logger: null, now}).beginProviderObservation(input());
  await h.markDispatched(); await aggregateCall(db, h.id);
  const legacy = {...db.read(COLLECTIONS.calls, h.id)};
  for (const key of ['aggregationVersion', 'aggregationPending', 'aggregatedContribution', 'aggregatedAt']) delete legacy[key];
  db.seed(COLLECTIONS.calls, h.id, legacy);
  await h.settle({result: {}});
  await aggregateCall(db, h.id);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000, uncertainLiabilityMicrodollars: 0});
});

test('failed and unsent accounting recovery never dispatches paid work or creates user records', async () => {
  const db = new FakeFirestore();
  const budget = createEngineBudget({db, journal: null, logger: null, now});
  const failed = budget.beginProviderObservation(input('failed'));
  const unsent = budget.beginProviderObservation(input('unsent'));
  await failed.settle({error: new Error('https://private.invalid/error')});
  await unsent.releaseUnsent();
  await drain(createEngineBudgetWorker({db, journal: null, logger: null}), db);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, unresolvedCalls: 1, settledCalls: 0, uncertainLiabilityMicrodollars: 32000});
  expect([...db.collections.keys()].sort()).toEqual(Object.values(COLLECTIONS).sort());
  expect(stored(db)).not.toContain('https://');
});

test('missing projection cannot silently become zero; repairing it replays the durable settlement', async () => {
  const db = new FakeFirestore();
  const h = createEngineBudget({db, journal: null, logger: null, now}).beginProviderObservation(input());
  await h.markDispatched(); await aggregateCall(db, h.id);
  const saved = getCounter(db), id = counterId('global', 'engine', DAY);
  await db.collection(COLLECTIONS.counters).doc(id).delete();
  await h.settle({result: {}});
  const worker = createEngineBudgetWorker({db, journal: null, logger: null});
  expect((await worker.tick()).failed).toBe(1);
  expect(worker.getDiagnostics().counts.counter_missing).toBe(1);
  expect(getCounter(db)).toBeUndefined();
  expect(db.read(COLLECTIONS.calls, h.id)).toMatchObject({state: 'settled', aggregationPending: true});
  db.seed(COLLECTIONS.counters, id, saved);
  await drain(worker, db);
  expect(getCounter(db)).toMatchObject({physicalCalls: 1, settledCalls: 1, knownActualMicrodollars: 32000, uncertainLiabilityMicrodollars: 0});
});

test('startup failures report static diagnostics and retry with bounded backoff, stop clears timers', async () => {
  jest.useFakeTimers();
  try {
    const logger = {warn: jest.fn()};
    const db = {collection: jest.fn(() => {throw new Error('https://private.invalid/db');})};
    const worker = createEngineBudgetWorker({db, journal: null, logger, intervalMs: 100, maxBackoffMs: 400});
    expect(db.collection).not.toHaveBeenCalled();
    worker.start(); worker.start();
    await worker.tick();
    expect(db.collection).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(199);
    expect(db.collection).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(db.collection).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(400);
    expect(db.collection).toHaveBeenCalledTimes(3);
    expect(worker.getDiagnostics().counts.aggregation_scan_failed).toBe(3);
    await worker.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(db.collection).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('https://');
    const unavailable = createEngineBudgetWorker({logger});
    unavailable.start();
    expect(unavailable.getDiagnostics().counts.ledger_unavailable).toBe(1);
    await unavailable.stop();
  } finally {jest.useRealTimers();}
});
