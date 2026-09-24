#!/usr/bin/env node
'use strict';

// Offline provenance generator. No environment dump, credentials, network,
// publishing, or implied deployment/compatibility certification.
// Usage (artifact paths must be files, e.g. CI's .tar.gz archives):
// npm run release:manifest -- --app-repo ../mapd-next-app --server-repo . \
//   --app-contract legacy-v1 --app-contract selection-v2 \
//   --server-contract enrichment-v2 --app-artifact /tmp/android-export.tar.gz \
//   --server-artifact /tmp/server-image.tar.gz --output /tmp/release.json
// Contract names are explicit operator declarations, not inferred from a build.
// Dirty trees fail by default; --allow-dirty produces review-only provenance.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fingerprint(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Expected a nonempty regular artifact/file: ${filename}`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return { file: path.basename(filename), bytes: stat.size, sha256: hash.digest('hex') };
}

async function repository(repo, files, allowDirty) {
  const root = path.resolve(repo);
  const revision = git(root, ['rev-parse', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=normal']).length > 0;
  if (dirty && !allowDirty) throw new Error(`Repository has uncommitted files: ${root}; use --allow-dirty only for review`);
  const trackedFiles = {};
  for (const file of files) {
    trackedFiles[file] = {
      ...(await fingerprint(path.join(root, file))),
      revision: git(root, ['log', '-1', '--format=%H', '--', file]) || null,
    };
  }
  return { revision, dirty, files: trackedFiles };
}

function contract(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error('Contract versions must be explicit nonempty identifiers');
  return value;
}

async function generateManifest(options) {
  const { appRepo, serverRepo, appContracts, serverContract, appArtifacts, serverArtifacts, allowDirty = false } = options;
  if (!appRepo || !serverRepo) throw new Error('Both --app-repo and --server-repo are required');
  if (!Array.isArray(appContracts) || new Set(appContracts).size < 2) throw new Error('Declare at least two distinct supported --app-contract versions (old and new)');
  const contracts = { server: contract(serverContract), supportedApps: [...new Set(appContracts.map(contract))], verification: 'declared; requires compatibility test evidence' };
  if (!appArtifacts?.length || !serverArtifacts?.length) throw new Error('Both --app-artifact and --server-artifact are required');
  const app = await repository(appRepo, ['package.json', 'package-lock.json', 'firestore.rules', 'firestore.indexes.json'], allowDirty);
  const server = await repository(serverRepo, ['package.json', 'package-lock.json', 'functions/package.json', 'functions/package-lock.json', 'lib/engineVersion.js', 'lib/engineFeatures.js', 'lib/media/mediaConfig.js', 'lib/media/providers/openaiTranscription.js', 'Dockerfile'], allowDirty);
  const artifacts = [];
  for (const [component, filenames] of [['app', appArtifacts], ['server', serverArtifacts]]) {
    for (const filename of filenames) artifacts.push({ component, ...(await fingerprint(path.resolve(filename))) });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: app.dirty || server.dirty ? 'review-only' : 'release-candidate',
    repositories: { app, server },
    contracts,
    rules: app.files['firestore.rules'],
    indexes: app.files['firestore.indexes.json'],
    artifacts,
    limitations: [
      'Artifact hashes identify supplied bytes; the caller must verify their CI source revision.',
      'Android JavaScript export does not establish installable preview or physical-device validation.',
      'This manifest is not a deployment record or a rollout approval.',
      'For media activation, attach the container digest, ffmpeg/ffprobe version reports, mediaRecoveryV1 device checks, and real-media evaluation. Default-off source code is not evidence of production activation.',
    ],
  };
}

function parseArgs(argv) {
  const options = { appContracts: [], appArtifacts: [], serverArtifacts: [] };
  const single = { '--app-repo': 'appRepo', '--server-repo': 'serverRepo', '--server-contract': 'serverContract', '--output': 'output' };
  const repeated = { '--app-contract': 'appContracts', '--app-artifact': 'appArtifacts', '--server-artifact': 'serverArtifacts' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-dirty') { options.allowDirty = true; continue; }
    if (!Object.hasOwn(single, arg) && !Object.hasOwn(repeated, arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (Object.hasOwn(repeated, arg)) options[repeated[arg]].push(value);
    else {
      if (options[single[arg]] !== undefined) throw new Error(`Duplicate argument: ${arg}`);
      options[single[arg]] = value;
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const manifest = await generateManifest(options);
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (options.output) fs.writeFileSync(path.resolve(options.output), json, { flag: 'wx' });
  else process.stdout.write(json);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { generateManifest, parseArgs, fingerprint };
