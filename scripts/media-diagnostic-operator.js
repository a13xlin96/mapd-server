#!/usr/bin/env node
'use strict';

// LOCAL operator utility. Never import server/lib/firestore or read/export
// service-account credentials. The caller's existing OAuth helper supplies db.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, createHash} = require('node:crypto');
const {COLLECTION, ROUTE, MAX_TICKET_MS} = require('../lib/mediaDiagnostic');
const {isAllowedExtractUrl} = require('../lib/urlValidation');
const {classifyContentProvider} = require('../lib/contentProvider');
const invalid = () => new Error('Invalid operator input');

function serverOrigin(server) {
  const u = new URL(server);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw invalid();
  return u.origin;
}
async function saveLocal(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {await handle.writeFile(JSON.stringify(value)); await handle.sync();}
  finally {await handle.close();}
}
async function readLocal(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw invalid();
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!/^[a-f0-9]{32}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.token)) throw invalid();
    value.server = serverOrigin(value.server);
    return value;
  } finally {await handle.close();}
}
async function createTicket(input) {
  const {db, userId, url, server, file, analysisMode, now = Date.now} = input;
  if (!db || typeof userId !== 'string' || !userId.length || userId.length > 128
      || typeof url !== 'string' || url.length > 2048 || !isAllowedExtractUrl(url) || !classifyContentProvider(url)
      || (Object.hasOwn(input, 'analysisMode') && analysisMode !== 'audio-only')) throw invalid();
  const origin = serverOrigin(server);
  const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex');
  const createdAtMs = now();
  // Save the secret durably first, exclusively and owner-readable. If the
  // Firestore acknowledgement is lost, this same local file can still invoke
  // the existing ticket; create() cannot overwrite any consumed ticket.
  await saveLocal(file, {schemaVersion:1, id, token, server:origin});
  // Old diagnostic readers reject remote v2 capabilities before doing work.
  // The local secret file is unchanged; it never chooses the execution mode.
  await db.collection(COLLECTION).doc(id).create({schemaVersion:analysisMode === 'audio-only' ? 2 : 1, status:'pending',
    tokenHash:createHash('sha256').update(token, 'utf8').digest('hex'), userId, url,
    ...(analysisMode === 'audio-only' ? {analysisMode} : {}),
    createdAtMs, expiresAtMs:createdAtMs + MAX_TICKET_MS});
  return {status:'pending'}; // Deliberately return/print neither token nor hash.
}
async function invokeOnce({file, fetchImpl = fetch}) {
  const local = await readLocal(file);
  // An exclusive fsync'd sidecar consumes local invocation before any network
  // call. Never delete it to retry an uncertain response. The server has a
  // separate durable fence, including across machines and HTTP replays.
  await saveLocal(`${file}.invoked`, {startedAtMs:Date.now()});
  const response = await fetchImpl(`${local.server}${ROUTE}/${local.id}`, {
    method:'POST', headers:{'x-media-diagnostic-token':local.token},
    redirect:'error', signal:AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  // Never echo a response body, URL, request options or thrown fetch error.
  return {httpStatus:response.status};
}
async function readResult({db, file, output}) {
  const local = await readLocal(file);
  const t = (await db.collection(COLLECTION).doc(local.id).get()).data();
  if (!t || !['pending', 'running', 'completed', 'partial', 'failed', 'stopped', 'timed_out'].includes(t.status)) throw invalid();
  const value = {status:t.status,
    ...(t.status === 'running' ? {executionExpired:!(t.deadlineMs > Date.now())} : {}),
    result:t.result || null};
  // Export only the server's sanitized result, never the ticket (UID/URL/hash).
  await saveLocal(output, value);
  return {status:t.status, resultSaved:!!t.result};
}
async function main(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--(auth-helper|project|user|url|server|file|output|analysis-mode)$/.test(args[i]) || !args[i + 1]
        || Object.hasOwn(options, args[i])) throw invalid();
    options[args[i]] = args[i + 1];
  }
  if (!['create', 'invoke', 'read'].includes(command) || !options['--file']) throw invalid();
  if (Object.hasOwn(options, '--analysis-mode') && (command !== 'create' || options['--analysis-mode'] !== 'audio-only')) throw invalid();
  let db;
  if (command !== 'invoke') {
    if (!options['--auth-helper'] || !options['--project']) throw invalid();
    // Adapter contract: getFirestore({projectId}) -> OAuth-authenticated Admin
    // Firestore, using the operator's already-approved local auth helper.
    const helper = require(path.resolve(options['--auth-helper']));
    db = await helper.getFirestore({projectId:options['--project']});
  }
  const result = command === 'create' ? await createTicket({db, userId:options['--user'], url:options['--url'],
    server:options['--server'], file:options['--file'],
    ...(Object.hasOwn(options, '--analysis-mode') ? {analysisMode:options['--analysis-mode']} : {}),
  }) : command === 'invoke' ? await invokeOnce({file:options['--file']})
    : await readResult({db, file:options['--file'], output:options['--output']});
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Diagnostic command failed; inspect private ticket state before any further action.\n');
  process.exitCode = 1;
});
module.exports = {createTicket, invokeOnce, readResult, main};
