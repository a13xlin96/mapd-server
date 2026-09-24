# Selective audio/video implementation — September 21, 2026

Status: local implementation and integration verification complete; independent review findings addressed. The media pilot is **off by default**. This report is not a deployment or real-world accuracy claim.

## Baseline preserved

- Server original: `/Users/alexlin/workspace/mapd-server-next`, HEAD `dd145e7` plus existing uncommitted reliability/cost changes.
- App original: `/Users/alexlin/workspace/mapd-next`, HEAD `9b1d485` plus existing uncommitted import/UI changes.
- Development copies: `/private/tmp/mapd-media-20260921/{server,app}`. SHA-256 baseline inventory: `/private/tmp/mapd-media-20260921/baseline.json`.
- Only implementation deltas are copied back, after checking original hashes against that inventory. Existing changes are not discarded.
- No paid inference, historical link processing, deployment, build submission, or production activation is part of this implementation.

## Implemented design

1. **Admission and compatibility:** strict v1/v2 feature readers, immutable per-job media policy, server cohort/flag AND `mediaRecoveryV1` client capability. Client fields alone cannot enable processing. v1 behavior stays off. The reader-first fleet marker is separate from the live media dispatch stop.
2. **Acquisition and local processing:** public direct-file renditions, streaming DNS-pinned/redirect-validated downloads, container/size/duration bounds, private reference-counted workspaces, restricted local ffmpeg/ffprobe, bounded audio and diverse video frames. Audio silence is not inferred from missing subtitle cues. Frame selection is a heuristic, not an OCR guarantee.
3. **Provider seam:** pinned `gpt-4o-mini-transcribe-2025-12-15`; honest chunk windows; alternate adapters can implement the same interface. Separate durable shared operations per chunk, frame batch, and text fusion. No provider retries or failover after uncertain dispatch.
4. **Grounded fusion:** literal original-language evidence, mechanical quote/reference/region checks, branch/geography support, one media escalation, no looping from final matching. New media venues require user confirmation. Conflicts downgrade existing automatic decisions. Provisional unchanged Google queries are reused.
5. **Cost and lifetime:** observation-only accounting, separate audio/text usage, duration estimates kept separate from actual usage, nullable unknown costs, deadlines and subscriber ownership, a technical emergency stop independent of spending. No monetary caps or cost-based routing were enabled.
6. **Recovery:** valid saves survive optional analysis failure. `complete + analysisRecovery` is separate from `partial_save`; known-unsaved venues still use strict partial-save progress. Retry analysis creates a new authorized receipt, reuses successful evidence and advances only durably authorized failed/uncertain operation generations. Dismissed venues remain dismissed. No automatic retry/revival.
7. **Evaluation:** versioned media corpus/labels, bounded hashed captures, development/holdout family isolation, label-blind replay, frozen Places responses, modality arms, separate candidate and real-save metrics. Offline replay is the default. No real corpus or accuracy numbers are invented.

## Execution checklist

- [x] M0: preserve dirty baselines and record local checks. Baseline server: 1,261 tests passed, 34 pre-existing opt-in skips; app baseline typecheck passed.
- [x] M1: schemas, recorded policy, capability/cohort admission, compatible readers and live dispatch stop.
- [x] M2: bounded acquisition, local decode and cleanup; actual FFmpeg generated-media smoke.
- [x] M3: replaceable transcription facade, pinned OpenAI adapter and fake alternate-provider tests.
- [x] M4: deterministic scene/grid sampling and bounded video vision; generated brief-clue and detailed-image mechanics verified.
- [x] M5: durable shared operations, cancellation, accounting and observation-only spend.
- [x] M6: selective escalation, final cross-modal fusion and conservative matching/selection.
- [x] M7: server outcomes plus durable mobile recovery and explicit retries.
- [x] M9 local verification: complete server/app suites, rules emulator, offline load/Functions checks, actual decoder smoke and independent adversarial re-review.
- [x] M8 tooling: versioned captured-media corpus, isolation, diagnostic replay and provider-free scoring.
- [ ] M8 empirical acceptance: authorized real corpus, live provider accuracy, cost and actual tester-save comparisons.
- [ ] M4b conditional: real brief-sign evidence must determine whether a local text detector is needed. The current selector is not claimed to detect text.
- [ ] Operational rollout: deployed compatible fleet/rules, production image smoke, pinned model access, physical-device QA, TTL verification and hardware/load measurements.

The baseline/source HEADs do not establish which server or rules release is currently deployed. Deployment inspection and release artifacts remain part of activation, not an inferred result of local tests. Detailed interfaces and limits are in [engine-media-contracts.md](engine-media-contracts.md).

## Review corrections

Independent reviews and integration probes drove these corrections before the final verification:

- Reject recoverable decoder corruption and discontinuous audio PTS; map the validated stream explicitly; retain resources until process close and detect PID reuse during orphan cleanup.
- Normalize detailed images before batching. Eight high-detail frames now stay within the vision payload envelope.
- Bound fragmented subtitle gap plans to the transcription facade's chunk limit without invented silence or coverage.
- Combine validated visual observations with speech in final fusion; explicit spoken corrections downgrade baseline automatic decisions.
- Preserve validated evidence when another modality expires, reserve time for fusion and saves, and keep successful evidence cache reuse separate from private user text.
- Keep reported ASR usage even when transcript validation fails. Pending dispatch identities are reconciled only on an explicit retry; nullable records do not authorize guessed generations.
- Preserve identified unresolved places on early analysis failure, validate bounded retry ancestry, and avoid duplicate progress counts when an existing pin or an overflow candidate reappears.
- Mobile retry receipts cannot be completed from a raw-URL match when server work remains; recovery anchors survive failed delivery/admission and dismissal remains durable. Explicit cleared recovery is distinguished from an unknown decision across SQLite restart, so newer unresolved places retain their proper retry anchor. An account/session guard runs immediately after SQLite claim before publishing a URL into the UI.
- Evaluation reports distinguish diagnostic replay from production latency, do not fabricate tester saves, and cannot grant rollout approval from synthetic fixtures.

## Cache and privacy

Raw files remain private and ephemeral. Successful derived operations use the existing 24-hour artifact cache; bounded source manifests may reuse completed evidence for **one hour**. A fresh manifest is an explicit freshness allowance, not a claim that the source bytes were downloaded again. Model, policy, source, caption/subtitles and private user scope participate in identities. Failed/partial manifests are never success-cached.

Distributed operation generation records retain the existing seven-day TTL eligibility; Firebase deletion is asynchronous. Verify actual TTL deployment before activation. Billing records exclude raw files and transcript text. Mobile job payloads receive modality status and recovery metadata, not audio/frame bodies or internal evidence quotes.

## Activation and rollback runbook

1. Deploy the preceding server/rules prerequisites and this implementation with **v1 writers/media flag off**. Confirm all claimers can read feature schema 2; stop older binaries. Do not assume a new document can fence binaries that predate its check.
2. Deploy the app with `mediaRecoveryV1` capture support and the pending-job rules allowing only that capability and explicit retry kind. Test capture, selection, save, dismissal, offline restart, account change, and manual retry on a device.
3. Build the production image; retain exact ffmpeg/ffprobe version reports from `/usr/local/share/mapd-*-version.txt` and the image digest. Run the real decoder smoke inside that image (`node tests/media/smoke.cjs`); missing binaries are a failure, not a skipped pass. Confirm CPU, memory, temp storage and p95 deadlines on deployment hardware.
4. Supply **server-only** `OPENAI_API_KEY`. Check the pinned snapshot is available to this account. Do not silently substitute a model. Configure valid media prices and verify retained v1 accounting journals replay.
5. Verify Firestore TTL policies, operation collections, and private access rules. Raw evaluation captures require separately authorized restricted storage and retention.
6. Load an authorized real-media corpus (minimum 100 development + 50 unseen holdout, target 60), execute all replay arms, and review venue/branch mistakes, brief-sign capture, latency, cost and unknown billing. Synthetic tests establish mechanics only. Pilot activation is blocked until this evidence passes the reviewed plan's gates.
7. Set server-only `engineControl/mediaFleet` to `{schemaVersion:1,minimumReaderVersion:2,writersEnabled:true}` only after the fleet is compatible. Configure `ENGINE_ROLLOUT_JSON` with `snapshotVersion:2`, internal UIDs, `flags.mediaEvidence:true`, and trusted optional `mediaPolicy`; other existing flags should be preserved. The writer still requires the app capability. Expand only after measured internal results.
8. To stop **new physical media calls immediately**, set `engineControl/mediaExecution` to `{schemaVersion:1,stopNewMediaDispatch:true}`. Already-authorized calls may finish and incur cost. Committed pins and existing evidence remain usable. To stop new enrollment, disable the rollout media flag; existing snapshots remain immutable. Keep v2 readers available while those jobs drain. Neither control schedules retries.

## Verification and remaining gates

Local verification results (no paid inference or production writes):

| Check | Result |
| --- | --- |
| Server `npm run test:ci` | 113 suites, 1,638 tests passed; 34 existing opt-in tests across three suites skipped |
| App `npm run typecheck` | Passed |
| App `npm run test:ci` | 80 suites, 1,173 tests passed |
| App Firestore rules emulator | 8 suites, 242 tests passed |
| Functions `npm run test:ci` | 13 tests passed |
| Existing offline engine regression | 32/32 passed |
| Evaluation/replay focused suite | 92/92 passed |
| Runtime/shared-operation emulator | 7/7 passed in independent runtime verification |
| Two-process offline load test | 10 stubbed requests, peak configured provider concurrency 1, no active work left |
| Real FFmpeg generated-media smoke | Passed; detail below |
| Scoped whitespace/diff checks | Passed |

Independent scoped re-reviews confirmed the retry/counting and app findings resolved (57 server and 145 app checks respectively); adapter follow-up passed 223 focused/integration checks. No known material findings remain in those reviewed scopes. Tests establish behavior under their fixtures, not production recognition quality.

The final source copy uses baseline SHA-256 checks. No deployment artifact or installable mobile build is represented by these results.

Real local decoder evidence uses FFmpeg/ffprobe 7.1.5, built in an isolated temporary directory. It verified a 3-second generated clip, selected the 1.2-second brief clue, and processed a generated detailed eight-frame batch (largest frame 1,364,161 bytes; aggregate 10,911,656 bytes). Additional actual-file cases reject permissively decodable corruption and audio PTS gaps, select only the validated video stream, and process 100 timed subtitle gaps as one real 15-second audio window. These demonstrate mechanics, not real venue recognition.

Docker is unavailable on this host, so the production container was not built or smoke-tested here. Its Dockerfile now runs the decoder smoke during build and retains binary version reports. Distribution FFmpeg versions can differ from the local 7.1.5 build; retain and validate the actual image before activation.

No real corpus was supplied for this task. No real recall, per-additional-venue cost, production p95 or savings result is reported. Instrumentation records submitted audio (including overlap), input/output usage, frames/pixels, cache reuse, downloaded bytes and wall/CPU windows. Process-wide CPU deltas can include concurrent work; they are diagnostic windows, not exclusive per-job CPU attribution. Production deployment, real provider/model access, paid accuracy evaluation, full labeled corpus, physical-device QA and deployment hardware benchmarks remain explicit rollout gates.
