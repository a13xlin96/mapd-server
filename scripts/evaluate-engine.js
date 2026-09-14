#!/usr/bin/env node
const fs = require('fs');
const {run} = require('../tests/engine/evaluate.cjs');
run().then(report => {
  const output = JSON.stringify(report, null, 2) + '\n';
  const flag = process.argv.indexOf('--output');
  if (flag >= 0 && process.argv[flag + 1]) fs.writeFileSync(process.argv[flag + 1], output);
  console.log(`${report.passed}/${report.total} offline regression scenarios pass. This is not live accuracy.`);
  for (const c of report.cases.filter(c=>!c.passed)) console.log(`FAIL ${c.id}${c.error ? ': '+c.error : ''}`);
  if (process.argv.includes('--strict') && report.passed !== report.total) process.exitCode = 1;
}).catch(error => {console.error(error);process.exitCode=1;});
