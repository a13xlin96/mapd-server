'use strict';

const {COLLECTIONS, persistEvent, aggregateCall} = require('./engineBudget');
const {createSpendJournal} = require('./engineBudgetJournal');

// Parent hook: createEngineBudgetWorker({db: firestore}).start(). Importing
// neither starts a timer nor initializes Admin. No provider/authorization APIs
// are reachable here: recovery replays accounting, never paid requests.
function createEngineBudgetWorker({db, journalDirectory, journal, logger = console,
  batchSize = 25, intervalMs = 1000, maxBackoffMs = 30000, journalTimeoutMs = 250} = {}) {
  const outbox = journal === null ? null : createSpendJournal({directory: journalDirectory});
  const size = Number.isInteger(batchSize) && batchSize > 0 ? Math.min(100, batchSize) : 25;
  const interval = Number.isFinite(intervalMs) ? Math.max(100, Math.min(60000, intervalMs)) : 1000;
  const maxDelay = Number.isFinite(maxBackoffMs) ? Math.max(interval, Math.min(300000, maxBackoffMs)) : Math.max(interval, 30000);
  const journalTimeout = Number.isFinite(journalTimeoutMs) ? Math.max(1, Math.min(5000, journalTimeoutMs)) : 250;
  const counts = Object.create(null);
  let started = false, timer = null, active = null, cursor = '', fileCursor = '', delay = interval;
  let recovery = null;
  function report(reason) {
    counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, (counts[reason] || 0) + 1);
    try { Promise.resolve(logger?.warn?.('engine_budget_aggregation', {mode: 'observe', reason})).catch(() => {}); }
    catch { /* only static diagnostics; never provider content/errors */ }
  }
  function schedule() {
    if (!started || !db) return;
    timer = setTimeout(() => { timer = null; void tick(); }, delay);
    timer.unref?.();
  }
  async function recoverJournal() {
    const result = {recovered: 0, failed: 0};
    try {
      const files = await outbox.list(fileCursor, size);
      if (!files.length) fileCursor = '';
      for (const file of files) {
        fileCursor = file;
        try {
          const {seed, event} = await outbox.read(file);
          await persistEvent(db, seed, event);
          await outbox.remove(file);
          result.recovered++;
        } catch (error) {
          // The producer/another worker may already have drained it.
          if (error?.code !== 'ENOENT') { result.failed++; report('journal_recovery_failed'); }
        }
      }
    } catch { result.failed++; report('journal_read_failed'); }
    return result;
  }
  async function recoverTick() {
    if (!outbox) return {recovered: 0, failed: 0};
    if (!recovery) {
      const current = {done: false, timedOut: false};
      recovery = current;
      current.promise = recoverJournal().then(result => { current.done = true; return result; });
    }
    const current = recovery;
    // A timeout stops waiting, never the underlying read/write/remove. Retain
    // its slot until completion so ticks cannot pile up overlapping retries.
    // Late completion is consumed on the next tick, including its failures.
    if (current.timedOut && !current.done) return {recovered: 0, failed: 0};
    let timer;
    try {
      const result = await Promise.race([current.promise, new Promise(resolve => {
        timer = setTimeout(() => resolve(null), journalTimeout);
      })]);
      if (result) { recovery = null; return result; }
      current.timedOut = true;
      report('journal_recovery_timeout');
      return {recovered: 0, failed: 1};
    } finally { clearTimeout(timer); }
  }
  function tick() {
    if (active) return active;
    clearTimeout(timer); timer = null;
    active = (async () => {
      const result = {recovered: 0, aggregated: 0, failed: 0};
      if (!db) return result;
      // At most one bounded Firestore retry group per event/call per tick.
      // A failed record stays durable. Cursors prevent a poison record from
      // starving later work; after restart discovery begins at the first row.
      // Local recovery and remote aggregation have independent progress. Even
      // a hung directory listing cannot stop this scan or subsequent ticks.
      const local = recoverTick();
      try {
        let query = db.collection(COLLECTIONS.calls).where('aggregationPending', '==', true).orderBy('__name__');
        if (cursor) query = query.startAfter(cursor);
        const page = await query.limit(size).get();
        if (!page.docs.length) cursor = '';
        for (const doc of page.docs) {
          cursor = doc.id;
          try { if (await aggregateCall(db, doc.id)) result.aggregated++; }
          catch (error) {
            result.failed++;
            const known = ['counter_missing', 'counter_corrupt', 'counter_overflow', 'identity_or_schema_conflict'];
            report(known.includes(error?.budgetDiagnostic) ? error.budgetDiagnostic : 'aggregation_failed');
          }
        }
      } catch { result.failed++; report('aggregation_scan_failed'); }
      // Back off remote failures only; a stuck filesystem must not slow the
      // healthy remote flow. Recovery itself keeps one bounded batch in flight.
      delay = result.failed ? Math.min(maxDelay, delay * 2) : interval;
      const recovered = await local;
      result.recovered = recovered.recovered;
      result.failed += recovered.failed;
      return result;
    })().catch(() => {
      report('worker_failed');
      delay = Math.min(maxDelay, delay * 2);
      return {recovered: 0, aggregated: 0, failed: 1};
    }).finally(() => { active = null; schedule(); });
    return active;
  }
  function start() {
    if (started) return;
    if (!db) { report('ledger_unavailable'); return; }
    started = true;
    void tick(); // tick catches and reports startup/scan errors itself
  }
  // Late local I/O retains its recovery slot; stopping need not await hung fs.
  async function stop() { started = false; clearTimeout(timer); timer = null; await active; }
  return {start, stop, tick, getDiagnostics: () => ({mode: 'observe', counts: {...counts}})};
}

module.exports = {createEngineBudgetWorker};
