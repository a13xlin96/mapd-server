const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const {createTicket, invokeOnce, readResult} = require('../scripts/media-diagnostic-operator');
const {COLLECTION, MAX_TICKET_MS} = require('../lib/mediaDiagnostic');
let directory, file, document, ref, db;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'media-diagnostic-operator-test-'));
  file = `${directory}/ticket.json`;
  ref = {create:jest.fn(async data => {document = data;}), get:jest.fn(async () => ({data:() => document}))};
  db = {collection:jest.fn(() => ({doc:jest.fn(() => ref)}))};
});
afterEach(async () => {if (directory) await fs.rm(directory, {recursive:true, force:true});});
const create = () => createTicket({db, userId:'approved-user', url:'https://www.instagram.com/reel/EXAMPLE/',
  server:'https://approved.example', file});

test('creates 256-bit local capability exclusively with 0600 permissions; Firestore gets only its hash', async () => {
  expect(await create()).toEqual({status:'pending'});
  const local = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(local.token).toMatch(/^[a-f0-9]{64}$/); expect(local.id).toMatch(/^[a-f0-9]{32}$/);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(db.collection).toHaveBeenCalledWith(COLLECTION);
  expect(document.tokenHash).toBe(createHash('sha256').update(local.token).digest('hex'));
  expect(document.expiresAtMs - document.createdAtMs).toBe(MAX_TICKET_MS);
  expect(JSON.stringify(document)).not.toContain(local.token);
  await expect(create()).rejects.toThrow(); expect(ref.create).toHaveBeenCalledTimes(1);
});

test('one invoke puts token only in header, no redirects/retries/body; marker is present before fetch', async () => {
  await create();
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
  await create(); document.status = 'completed'; document.result = {places:[{name:'Cafe'}], errors:[]};
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
