#!/usr/bin/env node
'use strict';
const fs = require('fs');
const {summarizeMetrics, compareAggregates} = require('../lib/engineMetrics');

function readJson(filename) {
  if (fs.statSync(filename).size > 64 * 1024 * 1024) throw new Error('Input exceeds 64 MiB');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function args(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error('Unknown or duplicate CLI option');
    if (['--help', '--schema', '--strict'].includes(key)) result[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing CLI option value');
      result[key] = argv[++i];
    }
  }
  return result;
}
// Exclusive creation prevents accidental replacement of seals/baselines, and
// 0600 protects newly created reports. Keep their parent directory private too.
function writePrivateJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
}
function main(argv) {
  const options = args(argv, ['--input', '--baseline', '--output', '--help']);
  if (options['--help']) {console.log('Usage: node scripts/engine-report.js --input private-attempts.json --output new-private-report.json [--baseline prior-report.json]\nInput: JSON array from engineMetrics.finish(). Output is descriptive attempt metrics, never accuracy. No provider calls. Files are created exclusively with mode 0600.'); return;}
  if (!options['--input'] || !options['--output']) throw new Error('Require --input and --output; use --help');
  const report = summarizeMetrics(readJson(options['--input']));
  if (options['--baseline']) {
    const baseline = readJson(options['--baseline']);
    if (baseline.schemaVersion !== 1 || baseline.scope !== report.scope) throw new Error('Incompatible baseline');
    report.comparison = compareAggregates(report, baseline);
  }
  writePrivateJson(options['--output'], report);
  console.log(`${report.overall.attempts} instrumented attempts summarized; real labeled corpus remains a release gate.`);
}
if (require.main === module) {try {main(process.argv.slice(2));} catch {console.error('Metrics report failed: invalid/missing input, baseline, or unavailable output path. Use --help.'); process.exitCode = 1;}}
module.exports = {readJson, args, writePrivateJson, main};
