#!/usr/bin/env node
const { createAccountingRepair, repairOptions } = require('../functions/lib/accountingRepair');

const USAGE = `Usage: node scripts/accounting-repair.js --project PROJECT --uid UID [options]
Default: bounded, read-only accountingInbox report for one explicit account.
  --apply                 Repair through the existing receipt-protected consumer
  --retry-needs-review    Include needs_review (preview by default; writes need --apply)
  --page-size N           Documents per query, 1..250 (default 100)
  --max-pages N           Queries per invocation, 1..20 (default 10)
  --cursor TOKEN          Resume using nextCursor from the same project/account/mode
  --help                  Show this help without loading Firebase
JSON lines: page checkpoints, then a final report. No event payloads or raw errors.
Resume from the last checkpoint after interruption; replay is receipt-protected.
On a blocker, nextCursor precedes that record (null means restart without --cursor).
Complete records consume the scan budget. A full page may need one more query.
Scan completion is not proof the inbox is drained: rerun from the beginning for
new inserts before the cursor or skipped needs_review records. Changing --apply
or --retry-needs-review requires a new scan. No persistent checkpoint is written.
Missing accounts, disabled capture and failures stop the pass and stay recoverable;
this tool does not enable capture, restore users, reset attempts or extract links.
Exit: 0 successful bounded pass; 2 blocker/review required; 130 aborted; 1 CLI/SDK failure.
Uses normal runtime ADC, with an explicit project only. No deployment is performed.`;

function parseArgs(argv) {
  const values = new Set(['project', 'uid', 'page-size', 'max-pages', 'cursor']);
  const flags = new Set(['apply', 'retry-needs-review', 'help']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if ((!values.has(key) && !flags.has(key)) || Object.hasOwn(args, key)) throw new Error('unknown_or_repeated_argument');
    if (flags.has(key)) args[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing_argument_value');
      args[key] = argv[++i];
    }
  }
  if (args.help) return { help: true };
  for (const key of ['page-size', 'max-pages']) {
    if (args[key] === undefined) continue;
    if (!/^\d+$/.test(args[key])) throw new Error(key === 'page-size' ? 'invalid_page_size' : 'invalid_max_pages');
    args[key] = Number(args[key]);
  }
  const options = { project: args.project, uid: args.uid, apply: !!args.apply,
    retryNeedsReview: !!args['retry-needs-review'], pageSize: args['page-size'], maxPages: args['max-pages'], cursor: args.cursor };
  repairOptions(options); // Validate before SDK initialization or credential lookup.
  return options;
}

async function main(argv, { loadAdmin = () => require('../functions/node_modules/firebase-admin'),
  output = console.log, signal } = {}) {
  const options = parseArgs(argv);
  if (options.help) { output(USAGE); return 0; }
  const admin = loadAdmin();
  const app = admin.initializeApp({ projectId: options.project });
  try {
    const repair = createAccountingRepair({ db: app.firestore(), admin });
    const report = await repair.run({ ...options, signal,
      onProgress: checkpoint => output(JSON.stringify({ type: 'checkpoint', ...checkpoint })) });
    output(JSON.stringify({ type: 'report', ...report }));
    if (report.stoppedReason === 'aborted') return 130;
    return (report.stoppedReason && report.stoppedReason !== 'page_limit')
      || (!options.retryNeedsReview && report.states.needs_review > 0) ? 2 : 0;
  } finally { await app.delete(); }
}

// Never print arbitrary SDK exception messages, which can contain document
// paths, URLs, request bodies or credentials. Parse errors are also fixed codes.
async function cli(argv, { errorOutput = console.error, ...dependencies } = {}) {
  try { parseArgs(argv); } catch (error) { errorOutput(error.message); return 1; }
  try { return await main(argv, dependencies); }
  catch { errorOutput('accounting_repair_failed'); return 1; }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  cli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; });
}
module.exports = { parseArgs, main, cli, USAGE };
