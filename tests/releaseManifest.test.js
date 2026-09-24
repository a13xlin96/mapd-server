'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { generateManifest, parseArgs, fingerprint } = require('../scripts/release-manifest');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapd-manifest-test-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('fingerprints actual artifact bytes and rejects empty, missing, directory, and symlink artifacts', async () => {
  const file = path.join(root, 'android.tar.gz');
  fs.writeFileSync(file, 'synthetic artifact');
  expect(await fingerprint(file)).toEqual({ file: 'android.tar.gz', bytes: 18, sha256: createHash('sha256').update('synthetic artifact').digest('hex') });
  fs.symlinkSync(file, path.join(root, 'link'));
  fs.writeFileSync(path.join(root, 'empty'), '');
  for (const invalid of [root, path.join(root, 'missing'), path.join(root, 'empty'), path.join(root, 'link')]) {
    await expect(fingerprint(invalid)).rejects.toThrow();
  }
});

test('requires complete cross-repo inputs and explicit old/new contracts', async () => {
  await expect(generateManifest({})).rejects.toThrow('Both --app-repo');
  await expect(generateManifest({ appRepo: '.', serverRepo: '.', appContracts: ['same', 'same'] })).rejects.toThrow('two distinct');
  await expect(generateManifest({ appRepo: '.', serverRepo: '.', appContracts: ['old', 'new'] })).rejects.toThrow('Contract versions');
  await expect(generateManifest({ appRepo: '.', serverRepo: '.', appContracts: ['old', 'new'], serverContract: 'v2' })).rejects.toThrow('Both --app-artifact');
});

test('parser rejects typos and missing values instead of silently making incomplete provenance', () => {
  expect(parseArgs(['--app-contract', 'v1', '--app-contract', 'v2', '--allow-dirty'])).toMatchObject({ appContracts: ['v1', 'v2'], allowDirty: true });
  for (const args of [['--unknown'], ['--app-repo'], ['--output', '--allow-dirty'], ['--server-contract', 'v1', '--server-contract', 'v2']]) {
    expect(() => parseArgs(args)).toThrow();
  }
});

test('records both revisions, rules/index revisions and hashes; dirty trees are review-only', async () => {
  // Mock only read-only git commands: no test commits or repository mutations.
  // Real working repos exercise the CLI separately during validation.
  const appRepo = path.join(root, 'app');
  const serverRepo = path.join(root, 'server');
  const files = {
    [appRepo]: ['package.json', 'package-lock.json', 'firestore.rules', 'firestore.indexes.json'],
    [serverRepo]: ['package.json', 'package-lock.json', 'functions/package.json', 'functions/package-lock.json', 'lib/engineVersion.js', 'lib/engineFeatures.js', 'lib/media/mediaConfig.js', 'lib/media/providers/openaiTranscription.js', 'Dockerfile'],
  };
  for (const [repo, names] of Object.entries(files)) {
    fs.mkdirSync(repo, { recursive: true });
    // An empty local repository supports status; HEAD is supplied by the mock.
    for (const name of names) {
      const filename = path.join(repo, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, name);
    }
  }
  const artifact = path.join(root, 'artifact.tar.gz'); fs.writeFileSync(artifact, 'artifact');
  let dirty = false;
  const mockGit = jest.fn((_cmd, args) => args.includes('status') ? (dirty ? ' M package.json\n' : '') : `${'a'.repeat(40)}\n`);
  jest.resetModules();
  jest.doMock('node:child_process', () => ({ execFileSync: mockGit }));
  try {
    const { generateManifest: generate } = require('../scripts/release-manifest');
    const options = { appRepo, serverRepo, appContracts: ['old-v1', 'new-v2'], serverContract: 'v2', appArtifacts: [artifact], serverArtifacts: [artifact] };
    const manifest = await generate(options);
    expect(manifest.purpose).toBe('release-candidate');
    expect(manifest.repositories.app.revision).toBe('a'.repeat(40));
    expect(manifest.repositories.server.revision).toBe('a'.repeat(40));
    expect(manifest.repositories.server.files['lib/media/mediaConfig.js'].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.rules.revision).toBe('a'.repeat(40));
    expect(manifest.indexes.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.map(entry => entry.component)).toEqual(['app', 'server']);
    expect(mockGit.mock.calls.every(([cmd, args]) => cmd === 'git' && ['rev-parse', 'status', 'log'].includes(args[2]))).toBe(true);
    dirty = true;
    await expect(generate(options)).rejects.toThrow('uncommitted');
    expect((await generate({ ...options, allowDirty: true })).purpose).toBe('review-only');
  } finally { jest.dontMock('node:child_process'); jest.resetModules(); }
});

test('CLI exits nonzero for incomplete input and does not create output', () => {
  const output = path.join(root, 'manifest.json');
  expect(() => execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/release-manifest.js'), '--output', output], { stdio: 'pipe' })).toThrow();
  expect(fs.existsSync(output)).toBe(false);
});
