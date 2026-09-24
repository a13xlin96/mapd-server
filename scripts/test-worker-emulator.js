// Two actual worker processes, real local Firestore, simulated shared Redis,
// stubbed extraction. Never run against a live project/provider.
const assert = require('node:assert/strict');
const http = require('node:http');
const { fork } = require('node:child_process');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-mapd-accounting';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')
  || !['demo-mapd-accounting', 'mapd-rules-test'].includes(projectId)) throw new Error('Local test emulator required');
const app = admin.initializeApp({ projectId }, `worker-emulator-${process.pid}`);
const db = app.firestore();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function child() {
  const { createWorker } = require('../lib/enrichmentWorker');
  const worker = createWorker({ db, policy: 'fair-queue-v1', capacity: 2,
    runEnrichment: async (id, _url, uid, _caption, options) => {
      process.send({ event: 'start', id, uid });
      await sleep(100);
      await db.runTransaction(async txn => {
        const ref = db.collection('enrichmentJobs').doc(id), data = (await txn.get(ref)).data();
        assert.equal(data.workerOwner, options.leaseOwner);
        assert.equal(data.status, 'processing');
        txn.update(ref, { status: 'complete' });
      });
      process.send({ event: 'end', id, uid });
    } });
  const stop = worker.start();
  await new Promise(resolve => process.on('message', m => { if (m === 'stop') resolve(); }));
  stop(); await worker.idle(); await app.delete();
  process.disconnect();
}

async function parent() {
  const store = new Map();
  const read = key => { const entry = store.get(key); return entry?.expires > Date.now() ? entry.value : null; };
  const command = ([verb, ...args]) => {
    let result;
    switch (String(verb).toUpperCase()) {
      case 'GET': result = read(args[0]); break;
      case 'SET': {
        const [key, value, ...options] = args, words = options.map(v => String(v).toUpperCase());
        if (words.includes('NX') && read(key) !== null) { result = null; break; }
        const ex = words.indexOf('EX');
        store.set(key, { value, expires: Date.now() + (ex < 0 ? 86400 : Number(options[ex + 1])) * 1000 });
        result = 'OK'; break;
      }
      case 'EVAL': {
        const [_script, _count, key, owner] = args;
        result = read(key) === owner ? 1 : 0;
        if (result) store.delete(key);
        break;
      }
      default: throw new Error('Unexpected simulated Redis command');
    }
    return { result: typeof result === 'string' && result !== 'OK' ? Buffer.from(result).toString('base64') : result };
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body[0]) ? body.map(command) : command(body)));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  const children = [], ends = new Set(), starts = new Set(), counts = new Map();
  let active = 0, peak = 0, failure = null;
  const started = Date.now(), expected = 70;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const batch = db.batch();
    const controller = require('../lib/engineFeatures').createEngineFeatures({}, {queuePolicy:'fair-queue-v1'});
    batch.set(db.collection('engineControl').doc('queueRollout'), {schemaVersion:1,policy:'fair-queue-v1'});
    for (let i = 0; i < expected; i++) {
      // Earliest 50 belong to one heavy user; eligible users lie beyond page 1.
      batch.set(db.collection('enrichmentJobs').doc(`worker-${String(expected - i).padStart(3, '0')}`), {
        userId: i < 50 ? 'heavy' : `light-${i % 4}`, status: 'pending', engineQueued: true,
        engineFeatures: controller.forJob(i < 50 ? 'heavy' : `light-${i % 4}`),
        url: 'https://example.test/fixture', admittedAt: admin.firestore.Timestamp.now(),
        queueDeadline: admin.firestore.Timestamp.fromMillis(Date.now() + 90000 + i),
      });
    }
    batch.set(db.collection('enrichmentJobs').doc('terminal-must-stay-stopped'), {
      userId: 'heavy', status: 'failed', engineQueued: true,
      queueDeadline: admin.firestore.Timestamp.fromMillis(Date.now() + 90000),
    });
    await batch.commit();
    for (let i = 0; i < 2; i++) {
      const proc = fork(__filename, ['--child'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: projectId,
          FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
          UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
          UPSTASH_REDIS_REST_TOKEN: 'synthetic-test-token' } });
      children.push(proc);
      proc.stderr.on('data', () => {});
      proc.on('error', error => { failure = error; });
      proc.on('exit', code => { if (code !== 0 && ends.size !== expected) failure = new Error(`Worker exited ${code}`); });
      proc.on('message', message => {
        try {
          if (message.event === 'error') throw new Error(message.message);
          if (message.event === 'start') {
            assert.ok(!starts.has(message.id), 'Duplicate execution'); starts.add(message.id);
            counts.set(message.uid, (counts.get(message.uid) || 0) + 1);
            assert.equal(counts.get(message.uid), 1, 'Per-user cap exceeded across processes');
            active++; peak = Math.max(peak, active); assert.ok(active <= 4, 'Global cap exceeded');
            if (message.uid.startsWith('light-')) assert.ok(ends.size < 50, 'Head account starved other users');
          } else if (message.event === 'end') {
            counts.set(message.uid, counts.get(message.uid) - 1); active--; ends.add(message.id);
          }
        } catch (error) { failure = error; }
      });
    }
    while (ends.size < expected && !failure && Date.now() - started < 65000) await sleep(100);
    if (failure) throw failure;
    assert.equal(ends.size, expected, 'Workers must recover and finish eligible jobs');
    assert.equal(starts.size, expected); assert.equal(active, 0);
    assert.equal((await db.collection('enrichmentJobs').doc('terminal-must-stay-stopped').get()).data().status, 'failed');
    console.log(JSON.stringify({ scope: 'two fair-worker processes, real local Firestore, simulated Redis, stubbed extraction',
      jobs: expected, peakGlobalConcurrency: peak, maxPerUserConcurrency: 1, elapsedMs: Date.now() - started }));
  } finally {
    await Promise.all(children.map(proc => new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      const timer = setTimeout(() => proc.kill(), 5000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      if (proc.connected) proc.send('stop'); else proc.kill();
    })));
    server.close(); await app.delete();
  }
}
(process.argv.includes('--child') ? child() : parent()).catch(error => {
  if (process.send) process.send({ event: 'error', message: error.message });
  else console.error(error);
  process.exitCode = 1;
});
