const {createEngineBudget, COLLECTIONS} = require('../../lib/engineBudget');
const {createEngineBudgetWorker} = require('../../lib/engineBudgetWorker');

// Old ledger assertions read counters synchronously. Explicitly drain the new
// asynchronous projection in this unit harness; production never waits for it.
function createBudgetHarness(options) {
  const budget = createEngineBudget({journal: null, ...options});
  const worker = createEngineBudgetWorker({db: options.db, journal: null, logger: null});
  async function drain() {
    if (!options.db?.read) return; // these tests inject deliberately broken DBs
    for (let i = 0; i < 20; i++) {
      const result = await worker.tick();
      if (result.failed || !(await options.db.collection(COLLECTIONS.calls).where('aggregationPending', '==', true).limit(1).get()).size) return result;
    }
    throw new Error('aggregation did not drain');
  }
  return {...budget, drain, worker, beginProviderObservation(input) {
    const handle = budget.beginProviderObservation(input);
    return Object.fromEntries(Object.entries(handle).map(([key, value]) => [key, typeof value !== 'function' ? value : async (...args) => {
      const receipt = await value(...args);
      await drain();
      return receipt;
    }]));
  }};
}
module.exports = {createBudgetHarness};
