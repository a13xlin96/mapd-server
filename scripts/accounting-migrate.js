#!/usr/bin/env node
const { createAccountingMigration } = require('../functions/lib/accountingMigration');

const USAGE = `Usage: node scripts/accounting-migrate.js --project PROJECT --uid UID [options]
Default: read-only parity report. Credentials use the runtime's normal ADC setup.
  --apply                 Run checkpointed backfill (writes)
  --initialize-capture    Report capture control; with --apply enable immutable cutover
  --activate              Validate readiness; with --apply atomically activate account
  --restart               With --apply, restart backfill from the beginning
  --page-size N           Query page size, 1..1000 (default 100)
  --max-pages N           Backfill pages this invocation (default 10)
  --expected-revision N   Require this revision when validating/activating
No project or account is inferred from the environment. No deployment is performed.`;

function parseArgs(argv) {
  const values = new Set(['project', 'uid', 'page-size', 'max-pages', 'expected-revision']);
  const flags = new Set(['apply', 'initialize-capture', 'activate', 'restart', 'help']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if ((!values.has(key) && !flags.has(key)) || Object.hasOwn(args, key)) throw new Error('unknown_or_repeated_argument');
    if (flags.has(key)) args[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing_${key}`);
      args[key] = argv[++i];
    }
  }
  if (args.help) return args;
  if (!args.project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(args.project)) throw new Error('explicit_valid_project_required');
  if (!args.uid || !require('../functions/lib/contentIdentity').validId(args.uid)) throw new Error('explicit_valid_uid_required');
  for (const key of ['page-size', 'max-pages', 'expected-revision']) {
    if (args[key] === undefined) continue;
    if (!/^\d+$/.test(args[key])) throw new Error(`invalid_${key}`);
    args[key] = Number(args[key]);
    if (!Number.isSafeInteger(args[key]) || args[key] < (key === 'expected-revision' ? 0 : 1)
      || (key === 'page-size' && args[key] > 1000)) throw new Error(`invalid_${key}`);
  }
  if (args.activate && args['initialize-capture']) throw new Error('conflicting_modes');
  if (args.restart && (!args.apply || args.activate || args['initialize-capture'])) throw new Error('restart_requires_backfill_apply');
  if (args['expected-revision'] !== undefined && args.apply && !args.activate) throw new Error('expected_revision_requires_validation');
  return args;
}

async function main(argv, { loadAdmin = () => require('firebase-admin'), output = console.log, signal } = {}) {
  const args = parseArgs(argv);
  if (args.help) { output(USAGE); return 0; }
  const admin = loadAdmin();
  const app = admin.initializeApp({ projectId: args.project });
  try {
    const migration = createAccountingMigration({ db: app.firestore(), admin });
    const options = { uid: args.uid, dryRun: !args.apply, pageSize: args['page-size'] || 100,
      maxPages: args['max-pages'] || 10, restart: !!args.restart, signal, expectedRevision: args['expected-revision'] };
    const report = args['initialize-capture'] ? await migration.initializeCapture(options)
      : args.activate || !args.apply ? await migration.verify({ ...options, activate: !!args.activate })
        : await migration.run(options);
    output(JSON.stringify({ project: args.project, ...report }, null, 2));
    return report.valid === false ? 2 : 0;
  } finally { await app.delete(); }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  main(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { parseArgs, main };
