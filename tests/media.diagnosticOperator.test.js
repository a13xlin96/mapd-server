const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const {createTicket, invokeOnce, readResult, main} = require('../scripts/media-diagnostic-operator');
const {COLLECTION, MAX_TICKET_MS} = require('../lib/mediaDiagnostic');
let directory, file, document, ref, db;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'media-diagnostic-operator-test-'));
  file = `${directory}/ticket.json`;
  ref = {create:jest.fn(async data => {document = data;}), get:jest.fn(async () => ({data:() => document}))};
  db = {collection:jest.fn(() => ({doc:jest.fn(() => ref)}))};
});
afterEach(async () => {if (directory) await fs.rm(directory, {recursive:true, force:true});});
const create = (options = {}) => createTicket({db, userId:'approved-user', url:'https://www.instagram.com/reel/EXAMPLE/',
  server:'https://approved.example', file, ...options});

test('creates 256-bit local capability exclusively with 0600 permissions; Firestore gets only its hash', async () => {
  expect(await create()).toEqual({status:'pending'});
  const local = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(local.token).toMatch(/^[a-f0-9]{64}$/); expect(local.id).toMatch(/^[a-f0-9]{32}$/);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(db.collection).toHaveBeenCalledWith(COLLECTION);
  expect(document.tokenHash).toBe(createHash('sha256').update(local.token).digest('hex'));
  expect(document.expiresAtMs - document.createdAtMs).toBe(MAX_TICKET_MS);
  expect(document.schemaVersion).toBe(1); expect(local.schemaVersion).toBe(1);
  expect(Object.hasOwn(document, 'analysisMode')).toBe(false);
  expect(Object.hasOwn(local, 'analysisMode')).toBe(false);
  expect(JSON.stringify(document)).not.toContain(local.token);
  await expect(create()).rejects.toThrow(); expect(ref.create).toHaveBeenCalledTimes(1);
});

test.each([{}, {analysisMode:'audio-only'}])('one invoke puts token only in header, no redirects/retries/body (%j)', async options => {
  await create(options);
  const local = JSON.parse(await fs.readFile(file, 'utf8'));
  const fetchImpl = jest.fn(async (url, options) => {
    expect((await fs.stat(`${file}.invoked`)).mode & 0o777).toBe(0o600);
    expect(url).toBe(`https://approved.example/internal/media-diagnostics/${local.id}`);
    expect(options).toMatchObject({method:'POST', redirect:'error', headers:{'x-media-diagnostic-token':local.token}});
    expect(options.body).toBeUndefined();
    return {status:202, body:{cancel:jest.fn()}};
  });
  expect(await invokeOnce({file, fetchImpl})).toEqual({httpStatus:202});
  await expect(invokeOnce({file, fetchImpl})).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('audio-only creates a remote v2 ticket rejected by v1-only readers; local capability stays v1', async () => {
  expect(await create({analysisMode:'audio-only'})).toEqual({status:'pending'});
  expect(document).toMatchObject({schemaVersion:2, analysisMode:'audio-only'});
  const local = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(local.schemaVersion).toBe(1);
  expect(Object.keys(local).sort()).toEqual(['id', 'schemaVersion', 'server', 'token']);
  expect(document.expiresAtMs - document.createdAtMs).toBe(MAX_TICKET_MS);
});

test.each([undefined, null, '', 'audio-video', 'audio-only ', 'AUDIO-ONLY', false, 1, [], {}, ['audio-only']].map(value => [value]))(
  'create rejects explicit malformed mode before writing any capability (%j)', async analysisMode => {
    await expect(create({analysisMode})).rejects.toThrow('Invalid operator input');
    expect(db.collection).not.toHaveBeenCalled();
    await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
  });

test.each([[], ['--analysis-mode', 'audio-only']].map(args => [args]))('create CLI accepts only its optional trusted audio-only selector (%j)', async modeArgs => {
  const helper = join(directory, 'mock-auth-helper.cjs'), getFirestore = jest.fn(async () => db);
  jest.doMock(helper, () => ({getFirestore}), {virtual:true});
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main(['create', '--auth-helper', helper, '--project', 'mock-project', '--user', 'approved-user',
      '--url', 'https://www.instagram.com/reel/EXAMPLE/', '--server', 'https://approved.example', '--file', file, ...modeArgs]);
    expect(getFirestore).toHaveBeenCalledWith({projectId:'mock-project'});
    expect(write).toHaveBeenCalledWith('{"status":"pending"}\n');
    expect(Object.hasOwn(document, 'analysisMode')).toBe(modeArgs.length > 0);
    expect(document.schemaVersion).toBe(modeArgs.length ? 2 : 1);
    if (modeArgs.length) expect(document.analysisMode).toBe('audio-only');
  } finally {write.mockRestore(); jest.dontMock(helper);}
});

test.each([
  ['invoke', '--analysis-mode', 'audio-only'], ['read', '--analysis-mode', 'audio-only'],
  ['create', '--analysis-mode', 'audio-video'], ['create', '--analysis-mode', 'audio-only '],
  ['create', '--analysis-mode'], ['create', '--analysis-mode', 'audio-only', '--analysis-mode', 'audio-only'],
].map(args => [args]))('CLI rejects mode outside create or malformed selector before auth/file/HTTP (%j)', async args => {
  const [command, ...options] = args, helper = join(directory, 'mock-auth-helper.cjs');
  const getFirestore = jest.fn(), fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
  jest.doMock(helper, () => ({getFirestore}), {virtual:true});
  try {
    await expect(main([command, '--file', file, '--auth-helper', helper, '--project', 'mock-project', ...options]))
      .rejects.toThrow('Invalid operator input');
    expect(getFirestore).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
    await expect(fs.stat(`${file}.invoked`)).rejects.toMatchObject({code:'ENOENT'});
  } finally {fetchSpy.mockRestore(); jest.dontMock(helper);}
});

test('uncertain invoke still consumes local marker and never retries', async () => {
  await create();
  const fetchImpl = jest.fn(async () => {throw new Error('lost acknowledgement');});
  await expect(invokeOnce({file, fetchImpl})).rejects.toThrow();
  await expect(invokeOnce({file, fetchImpl})).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('create failure retains local capability for admin inspection without a second create', async () => {
  ref.create.mockRejectedValue(new Error('uncertain commit'));
  await expect(create()).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(file, 'utf8')).token).toMatch(/^[a-f0-9]{64}$/);
  await expect(create()).rejects.toThrow(); expect(ref.create).toHaveBeenCalledTimes(1);
});

test('admin read exports only sanitized private result, never hash/UID/URL/token', async () => {
  await create({analysisMode:'audio-only'}); document.status = 'completed';
  document.result = {analysisMode:'audio-only', places:[{name:'Cafe'}], errors:[]};
  const output = `${directory}/result.json`;
  expect(await readResult({db, file, output})).toEqual({status:'completed', resultSaved:true});
  expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual({status:'completed', result:document.result});
  expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
});

test('insecure local secret permissions and symlinks are rejected before HTTP', async () => {
  await create(); const fetchImpl = jest.fn();
  await fs.chmod(file, 0o644);
  await expect(invokeOnce({file, fetchImpl})).rejects.toThrow();
  await fs.chmod(file, 0o600); await fs.symlink(file, `${directory}/symlink.json`);
  await expect(invokeOnce({file:`${directory}/symlink.json`, fetchImpl})).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
