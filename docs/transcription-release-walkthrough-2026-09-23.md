# Transcription configuration and staged release

## Verified source and hosting configuration

- Render service: `mapd-server`, source `a13xlin96/mapd-server`, branch `main`, Dockerfile `./Dockerfile`, Auto-Deploy **On Commit** (operator screenshots).
- GitHub `main` was `16a62c328ba8357ca67848ff2df7610139f7150c` on inspection. Existing draft PR #8 is the release vehicle; its feature branch is `feat/engine-next-improvements`.
- The operator reports saving server-only `OPENAI_API_KEY`. Runtime presence, billing and model access have not been verified. Render Shell is unavailable on the current free plan.
- A feature-branch push updates the draft PR and its checks. Updating `main` starts the production deployment. Do not confuse publication of the draft with production deployment.

## Before merging

1. Require fresh checks on the new PR revision, especially the production Docker build. The Dockerfile runs the real decoder smoke against the binaries installed in the image; synthetic unit tests alone do not prove those binaries work.
2. Follow `engine-next-improvements-execution-2026-09-14.md` for the preceding accounting capture, additive Firebase rules/indexes and Functions prerequisites. These are separate deployments; a Render server deployment cannot install Firebase triggers or mobile changes.
3. Confirm production configuration retains v1 feature writers and media enrollment off. Preserve existing unrelated settings. Do not enable `flags.mediaEvidence`, v2 writers, a new queue policy, monetary enforcement, or historical retries as part of this key setup.
4. Review the exact merge revision and the currently deployed revision before merging. Keep the draft unmerged if deployment prerequisites are unverified.

## After the production deployment succeeds

Open the Render service's Logs and find `transcription_readiness`. Expected for this phase:

```json
{"event":"transcription_readiness","apiKeyConfigured":true,"model":"gpt-4o-mini-transcribe-2025-12-15","modelAccess":"not_tested","mediaEnrollment":"off"}
```

The startup diagnostic performs no network calls. It reports only fixed labels and key presence, never key bytes, private cohort IDs or raw configuration. `apiKeyConfigured` is not a claim that OpenAI accepted the key. `configured` means a media enrollment flag was requested, not that the fleet/client gates passed. `invalid_config` means the rollout configuration needs correction; it does not echo the supplied value.

If key presence is false, check that the exact environment variable name was saved on this service and incorporated in the deployment. Do not paste the value in chat or logs.

## Live access test remains separate

A short, explicitly initiated transcription of non-sensitive sample audio must verify the pinned model and billing. The release does not run paid checks automatically on startup or replay user shares for testing. Model availability and full engine recognition quality are separate checks. Retain the media-off state until the implementation report's real-video evaluation and client/fleet requirements are met.

## Local verification for this candidate

- Server: 1,649 tests passed on Node 20.20.2 (matching hosted CI); 34 existing opt-in tests skipped.
- Functions package: 13 tests passed.
- Offline engine regression: 32/32 scenarios passed.
- Startup diagnostic: covered by the server suite, including key non-disclosure, invalid private configuration and no network calls.
- Docker is unavailable locally. The first hosted production-container build, actual decoder smoke, Functions and database-emulator checks passed. Its unit-test job exposed a download cleanup race and a timing-sensitive fixture; the follow-up fixes require fresh hosted checks.

These results do not establish any production deployment, model access, physical-device test or live accuracy result.

## Independent release review

The September 23 read-only compatibility review approved the bounded readiness diagnostic and identified deployment prerequisites that are not disabled by the media flag:

- The old interest-profile write endpoint becomes a compatibility no-op. Its replacement needs the new accounting Functions plus initialized `accountingControls/current.captureEnabled` and `historyCoverageStart`. Confirm capture before deploying this server; otherwise saves can succeed without recording the replacement interest history.
- Verify composite indexes for `pinDetailTasks(status, deadline)`, `pinDetailTasks(status, createdAt)`, and `enrichmentJobs(status, engineQueued, queueDeadline)` (ascending fields), plus TTL for `engineSharedAiOperations.expireAt`. The companion app contains the index definitions; their presence in production is unverified.
- Verify Redis coordination or an explicitly valid single-process setup and Firestore access. Startup begins the normal workers, which can process previously authorized work even while media enrollment is off.

Disposition: update the draft PR and run clean CI; do not merge or deploy until these dependencies are verified. No defect was found in the new readiness logger. The review did not inspect live production configuration.

Subsequent read-only Firebase inspection of the repository-configured project `mapd-820d4` found only `enrichOnPendingJob` deployed. `accountingPinWritten`, `accountingVisitWritten` and `accountingUserDeleted` are not deployed there. No functions, rules, indexes or documents were modified during inspection.

The first hosted run caught a real asynchronous output-open race: `pipeline()` could reject before `WriteStream` opened its exclusive destination, letting cleanup finish too early. The downloader now waits for output closure before ownership-based deletion. A delayed-open regression covers it, and independent review found no issue in the fix. Transcription and shared-operation deadline fixtures now use controlled clocks to distinguish pre-dispatch failure, post-dispatch uncertainty, and parent cancellation without depending on a fast runner.
