'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {randomUUID} = require('crypto');
const {fixture, copy} = require('./helpers/multimodalEvaluationFixture');
const {createReplayInputs, validateInputs, replayMultimodal} = require('../lib/multimodalReplay');
const {checksum, validatePredictions} = require('../lib/labeledEvaluationSchema');
const {evaluateLabeledCorpus} = require('../lib/labeledEvaluation');
const {writePrivateJson} = require('../scripts/engine-report');

describe('label-blind offline multimodal producer', () => {
  let dir, f, options;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-replay-test-')); f = fixture();
    for (const [hash, bytes] of f.files) fs.writeFileSync(path.join(dir, `${hash}.bin`), bytes, {mode: 0o600});
    options = {inputs: f.inputs, recordings: f.recordings, places: f.places, directory: dir};
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));
  test('redacts every private answer/grouping field before exposing inputs', () => {
    const input = createReplayInputs(f.corpus, f.seal, 'holdout'), json = JSON.stringify(input);
    for (const field of ['supports', 'expectedVenues', 'disposition', 'verification', 'coverage', 'familyId', 'reportedFailure']) expect(json).not.toContain(`"${field}"`);
    expect(input.cases).toHaveLength(7);
    input.cases[0].expectedVenues = [];
    expect(() => validateInputs(input)).toThrow('exact fields');
    expect(() => validateInputs(f.corpus)).toThrow();
  });
  test('five arms use identical captured inputs, recorded outputs and shipped ranker; no fake saves', async () => {
    const network = jest.spyOn(global, 'fetch').mockImplementation(() => {throw new Error('Network forbidden');});
    try {
      const reports = await replayMultimodal(options);
      expect(reports.map(r => r.arm)).toEqual(['baseline', 'audio', 'frames', 'combined', 'selective']);
      expect(new Set(reports.map(r => r.frozenPlacesSha256)).size).toBe(1);
      for (const p of reports) {
        expect(validatePredictions(p, f.corpus, f.seal)).toBe(p);
        expect(p.results).toHaveLength(7);
        expect(p.results.every(r => !r.autoSaved.length && !r.confirmedSaved.length && !r.saveAttestation)).toBe(true);
      }
      const counts = reports.map(p => evaluateLabeledCorpus(f.corpus, p, f.seal).overall.quality.candidateRecall.numerator);
      expect(counts).toEqual([1, 3, 3, 4, 4]);
      expect(reports[4].results[0].analysis.audio.status).toBe('complete'); // Shipped policy escalates missing subtitles.
      expect(reports[4].results[1].analysis.audio.status).toBe('complete');
      expect(reports[3].results[1].candidates[0].requiresSelection).toBe(true);
      expect(reports[0].results[0].automaticDecisions).toHaveLength(1);
      expect(network).not.toHaveBeenCalled();
    } finally {network.mockRestore();}
  });
  test('injected functions receive captured bytes and observed evidence only, never labels', async () => {
    const calls = [];
    const stages = Object.fromEntries(['baseline', 'audio', 'frames'].map(kind => [kind, async context => {
      calls.push({kind, context}); const c = f.recordings.cases.find(r => r.caseId === context.caseId);
      expect(context.assets.every(a => Buffer.isBuffer(a.bytes))).toBe(true);
      for (const key of ['supports', 'expectedVenues', 'disposition', 'familyId', 'coverage']) expect(context[key]).toBeUndefined();
      return c.responses[kind];
    }]));
    const reports = await replayMultimodal({...options, arms: ['selective'], stages});
    expect(calls).toHaveLength(21); // Shipped policy escalates all seven thin/missing-subtitle captures.
    expect(validatePredictions(reports[0], f.corpus, f.seal)).toBe(reports[0]);
  });
  test('caption naming one venue can still escalate and retain additional media candidates', async () => {
    const target = f.recordings.cases[1], extra = f.selected[1];
    target.responses.baseline = copy(f.recordings.cases[0].responses.baseline);
    target.responses.baseline.observations[0].nameRefs = [extra.captionRef];
    target.responses.baseline.observations[0].branchRefs = [extra.captionRef];
    target.responses.baseline.needsMoreEvidence = true;
    f.places.entries.push({...copy(f.places.entries[0]), caseId: target.caseId});
    const [p] = await replayMultimodal({...options, arms: ['selective']});
    expect(p.results[1].candidates).toHaveLength(2); expect(p.results[1].analysis.audio.status).toBe('complete');
  });
  test('missing stage records are failures, partial evidence is preserved and every case remains present', async () => {
    f.recordings.cases[3].responses.audio = null;
    const [p] = await replayMultimodal({...options, arms: ['combined']});
    expect(p.results).toHaveLength(7);
    expect(p.results[3]).toMatchObject({failure: 'recording_missing', partial: true});
    expect(p.results[3].candidates).toHaveLength(1); // recovered by frame evidence.
    expect(p.results[3].analysis.audio.status).toBe('failed');
    expect(validatePredictions(p, f.corpus, f.seal)).toBe(p);
    expect(evaluateLabeledCorpus(f.corpus, p, f.seal).overall.cost.totalUsd).toBeNull();
  });
  test('missing whole case records never disappear from denominators', async () => {
    f.recordings.cases.splice(1, 1);
    const [p] = await replayMultimodal({...options, arms: ['combined']});
    expect(p.results[1]).toMatchObject({failure: 'recording_missing', partial: true, candidates: []});
    expect(p.results).toHaveLength(7);
  });
  test('missing frozen query is a failure; an explicitly empty response is a measured no-match', async () => {
    const target = f.places.entries.shift();
    let [p] = await replayMultimodal({...options, arms: ['baseline']});
    expect(p.results[0].failure).toBe('stage_failed');
    f.places.entries.push({...target, results: []});
    [p] = await replayMultimodal({...options, arms: ['baseline']});
    expect(p.results[0].failure).toBeNull(); expect(p.results[0].candidates).toEqual([]);
  });
  test('tampered bytes or mismatched capture/Places bindings stop before adapters', async () => {
    const baseline = jest.fn(); f.places.inputsSha256 = '0'.repeat(64);
    await expect(replayMultimodal({...options, stages: {baseline}})).rejects.toThrow('checksum');
    f.places.inputsSha256 = checksum(f.inputs);
    const a = f.inputs.cases[0].assets[0]; fs.writeFileSync(path.join(dir, `${a.sha256}.bin`), Buffer.alloc(a.byteLength));
    await expect(replayMultimodal({...options, stages: {baseline}})).rejects.toThrow('checksum');
    expect(baseline).not.toHaveBeenCalled();
  });
  test('cancellation before dispatch, after provider response and expiry prevent publication or restart', async () => {
    for (const phase of ['before', 'after', 'deadline']) {
      const controller = new AbortController(); if (phase === 'before') controller.abort();
      const baseline = jest.fn(async context => {controller.abort(); return f.recordings.cases.find(r => r.caseId === context.caseId).responses.baseline;});
      const [p] = await replayMultimodal({...options, arms: ['baseline'], stages: {baseline}, signal: controller.signal, deadlineMs: phase === 'deadline' ? Date.now() - 1 : null});
      expect(baseline).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
      expect(p.results.every(r => !r.candidates.length && ['cancelled', 'deadline'].includes(r.failure))).toBe(true);
    }
  });
  test('live mode requires explicit permitted inputs, run authorization and trusted callbacks', async () => {
    const baseline = jest.fn(), stages = {baseline, audio: jest.fn(), frames: jest.fn()};
    await expect(replayMultimodal({...options, mode: 'live'})).rejects.toThrow('authorization');
    await expect(replayMultimodal({...options, mode: 'live', stages, liveAuthorization: {allowPaidInference: true, permittedInputsSha256: '0'.repeat(64), credentialSource: 'server_environment', runId: randomUUID()}})).rejects.toThrow('permitted');
    await expect(replayMultimodal({...options, stages: {module: '/tmp/execute.js'}})).rejects.toThrow('trusted');
    expect(baseline).not.toHaveBeenCalled();
  });
  test('approved in-process live adapter interface still makes no actual saves or borrowed cost claims', async () => {
    const stages = Object.fromEntries(['baseline', 'audio', 'frames'].map(k => [k, async ({caseId}) => f.recordings.cases.find(r => r.caseId === caseId).responses[k]]));
    const [p] = await replayMultimodal({...options, arms: ['combined'], mode: 'live', stages, liveAuthorization: {allowPaidInference: true, permittedInputsSha256: checksum(f.inputs), credentialSource: 'server_environment', runId: randomUUID()}});
    expect(p.execution).toBe('captured_inference'); expect(p.results.every(r => !r.autoSaved.length && !r.attemptMetrics.length)).toBe(true);
    expect(validatePredictions(p, f.corpus, f.seal)).toBe(p);
  });
  test('private CLI import -> replay -> score works, with no overwrite/live/module path support', () => {
    const file = (name, value) => {const target = path.join(dir, name); writePrivateJson(target, value); return target;};
    const run = (name, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', name), ...args], {encoding: 'utf8'});
    const corpus = file('corpus.json', f.corpus), seal = path.join(dir, 'seal.json'), inputs = path.join(dir, 'inputs.json');
    let result = run('import-engine-corpus.js', ['--input', corpus, '--evidence-dir', dir, '--seal', seal, '--replay-inputs', inputs, '--split', 'holdout']);
    expect(result.status).toBe(0); expect(fs.statSync(inputs).mode & 0o777).toBe(0o600);
    const recordings = file('recordings.json', f.recordings), places = file('places.json', f.places), output = path.join(dir, 'predictions');
    const args = ['--inputs', inputs, '--evidence-dir', dir, '--recordings', recordings, '--places', places, '--output-dir', output];
    result = run('replay-multimodal-engine.js', args); expect(result.status).toBe(0);
    expect(fs.readdirSync(output).sort()).toEqual(['audio.json', 'baseline.json', 'combined.json', 'frames.json', 'selective.json']);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700); expect(fs.statSync(path.join(output, 'combined.json')).mode & 0o777).toBe(0o600);
    expect(run('replay-multimodal-engine.js', args).status).toBe(1);
    expect(run('replay-multimodal-engine.js', [...args, '--mode', 'live']).status).toBe(1);
    expect(run('replay-multimodal-engine.js', [...args, '--adapter', '/tmp/code.js']).status).toBe(1);
    const report = path.join(dir, 'report.json');
    result = run('evaluate-labeled-engine.js', ['--corpus', corpus, '--evidence-dir', dir, '--seal', seal, '--predictions', path.join(output, 'combined.json'), '--output', report, '--strict']);
    expect(result.status).toBe(2); expect(JSON.parse(fs.readFileSync(report)).releaseGate.readyForRollout).toBe(false);
  });
});
