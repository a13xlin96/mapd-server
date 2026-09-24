// Production deliberately does not await telemetry. Tests must drain the
// default observer before replacing datastore mocks or tearing down modules.
// Factory-specific outage tests own and drain their deliberately broken DBs.
afterEach(async () => {
  const ledger = require('../../lib/engineBudget');
  await ledger.flushProviderObservations?.();
});
