#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const {args, readJson, writePrivateJson} = require('./engine-report');
const {replayMultimodal} = require('../lib/multimodalReplay');
const {ARMS} = require('../lib/labeledPredictionV2');
/** CLI deliberately offers NO module path, eval, shell command, remote URL or
 * credentials option. Live adapters may only be registered by trusted code. */
async function main(argv) {
  const options = args(argv, ['--inputs', '--evidence-dir', '--recordings', '--places', '--output-dir', '--mode', '--arms', '--help']);
  if (options['--help']) {
    console.log(`Usage: node scripts/replay-multimodal-engine.js --inputs private-label-blind-inputs.json --evidence-dir restricted-captures --recordings recorded-responses.json --places frozen-places.json --output-dir NEW-private-directory [--mode offline] [--arms baseline,audio,frames,combined,selective]
Export --replay-inputs from import-engine-corpus.js; this producer rejects corpus/label fields. Recorded provider outputs and Places entries are bound to checksum(inputs). Every arm reads identical hashed captures. The shipped ranker runs on frozen Places responses; media candidates require confirmation. Candidates and automatic decisions are predictions, not persisted pins. Real saves are never fabricated.
Recordings schema: {schemaVersion:2,inputsSha256,versions:{engine,prompt,model,sampling,adapter},cacheState:cold|warm,cases:[{caseId,responses:{baseline,audio,frames},metricsByArm:{baseline:[],audio:[],frames:[],combined:[],selective:[]}}]}. Responses are normalized actual provider observations, not gold transcripts. Each stage: {text,observations:[{query,name,city,address,country,nameRefs,branchRefs,requiresSelection}],needsMoreEvidence,coverage}; baseline coverage=null; media coverage={status,plannedRefs,observedRefs,reason}. Missing recordings produce explicit failures, never skipped cases. Supplied original attemptMetrics determine cost/latency; replay wall time does not. Missing metrics remain unknown.
Frozen Places: {schemaVersion:2,inputsSha256,entries:[{caseId,query,results:[{place_id,name,formatted_address,lat,lng,venueId,branchId}]}]}. Canonical identity mappings cover all returned candidates and must not reveal expected answers. Missing queries are failures, empty recorded results are allowed.
Evidence references: {assetId,modality:text|audio|frame,intervalMs:[start,end]|null,textRange:[start,end]|null,region:[left,top,right,bottom]|null}. Timings are local to assets; point intervals identify observed frames, private annotations may span the interval containing a sign. Caption ranges are UTF-16 offsets. Name and branch support are separate; audio cannot satisfy a frame citation at the same time.
Selective replay uses shipped mediaEligibility with captured text/subtitles and frozen baseline matches, never recording flags or labels. Replay timing is diagnostic, not production p95; deployment latency validation remains blocked.
Offline is the default and performs no network/production writes. This CLI remains offline-only. Trusted callers may use the library's createRuntimeReplayAdapters factory for shipped ASR, vision and crossmodal fusion over permitted local captures; live inference additionally requires explicit paid-inference permission, permitted-input digest, run UUID and server-environment credential attestation. No secrets or executable module paths are accepted by this CLI. No real corpus is bundled. New output directory is mode 0700, JSON files mode 0600; existing outputs are never replaced.`);
    return;
  }
  if ((options['--mode'] || 'offline') !== 'offline') throw new Error('Live CLI disabled: reviewed registered adapters, explicit permitted data and server credentials are required; no calls made');
  if (['--inputs', '--evidence-dir', '--recordings', '--places', '--output-dir'].some(k => !options[k])) throw new Error('Require label-blind inputs, captures, recordings, frozen Places and a NEW output directory');
  if (fs.existsSync(options['--output-dir'])) throw new Error('Output directory must not exist');
  const reports = await replayMultimodal({inputs: readJson(options['--inputs']), directory: options['--evidence-dir'], recordings: readJson(options['--recordings']), places: readJson(options['--places']), arms: options['--arms'] ? options['--arms'].split(',') : ARMS});
  fs.mkdirSync(options['--output-dir'], {mode: 0o700});
  for (const report of reports) writePrivateJson(path.join(options['--output-dir'], `${report.arm}.json`), report);
  console.log(`Wrote ${reports.length} offline prediction arms; no provider calls or pins saved. Recorded outcomes do not establish real accuracy without independent captured labels.`);
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {console.error('Replay failed: invalid/unavailable private inputs, mode or output; use --help. No automatic retry.'); process.exitCode = 1;});
module.exports = {main};
