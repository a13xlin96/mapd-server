# Mapd next improvements — implementation and release record

Prepared September 14, 2026. App baseline `791e103`; server baseline `3e9b194`. Work is isolated on `feat/engine-next-improvements` in both repositories. This record describes local code and verification, not a production deployment or measured improvement in live accuracy.

## Delivered implementation

| Package | Result |
|---|---|
| F1 | Committed pin/visit event capture, receipt-protected current totals and private save history, v2 interest/trip save summaries, bounded repair tooling and resumable migration. The legacy category-only endpoint acknowledges without inventing saves. |
| F2 | Owner-scoped content lookup with bounded index rows and current-pin validation; server writes index memberships atomically with saves. One indexed venue no longer completes a multi-place post. |
| F3 | Private stage, usage, queue and outcome reports; dated/explicitly unknown costs; strict real-corpus import, holdout sealing and comparison tools. Synthetic tests remain separate from real accuracy. |
| F4 | Clean-install CI in both repositories, separate Functions checks, rules and real transaction/worker emulator checks, Docker smoke job, Android export and artifact manifests. Recorded feature assignments and emergency admission stop are implemented. |
| F5 | Globally ordered discovery, bounded pagination, distributed per-account/global limits, coalesced wakeups, idle backoff and independent pending expiry. A private fleet-policy fence prevents new code from claiming under a mismatched policy. |
| F6 | Exact provider routing, gated YouTube processing, at most two useful subtitle tracks with native-language/provenance preservation. Blocked tracks remain distinguishable from no venue evidence and cannot become cached complete reads. |
| F7 | Owned SQLite browsing cache, root-owned subscriptions, account/session guards, explicit Activity selection recovery, crash-safe confirmation and durable dismissal. Foreign cached content is not used as authorization. |

## Accounting and recommendation data

- `users/{uid}/stats/current`: current owned pin/visited-pin inventory. `building` is not a valid zero; only validated `ready` accounts may use the projection reader.
- `users/{uid}/interestProfile/v2`: verified post-cutover in-app save/source actions. A persisted pin proves an app action, not the truth of its arbitrary category text or a physical visit.
- `users/{uid}/interestProfile/baseline`: bounded summary of currently owned pins whose server creation time predates cutover, written on validated activation. Its categories/cities/countries and omitted-label counts are inventory, not reconstructed historical saves. Never add them to verified event counts.
- `users/{uid}/saveEvents`: private committed action history; mutation identity/generation deduplicates delivery. Delayed notifications do not restore deleted current inventory. Source manifests are chunked to avoid exceeding document limits.
- `users/{uid}/tripSaveStats`: independently verified save-derived trip totals. The legacy root counters/trip aggregates are preserved for old clients and are not merged into v2.
- Existing profile and funnel history remain intact. No analytics purge or live migration was run. There is no production recommendation/ads consumer to switch in these repositories; phase-two consumers must choose the explicitly labeled baseline and verified v2 data rather than treating legacy counts as canonical.

Capture is disabled until `accountingControls/current` has an enabled, immutable history cutover. Deploy/enable capture and verify it before retiring the old writer in the running service. Keep capture enabled during reader rollbacks. Repairing accounting never launches extraction or restarts a failed link.

## Configuration and rollout contract

`ENGINE_ROLLOUT_JSON` is server configuration only. It accepts a version, stable cohort salt, internal account IDs, rollout percentage (0/5/25/100), projection/content/language flags, and `admission.stopNewJobs`. Internal account IDs are never returned to clients. Missing configuration leaves optional readers/language behavior off. New jobs record their assignment; execution validates that record without reparsing a later live rollout configuration.

Queue policy is intentionally not an account flag. `ENGINE_QUEUE_POLICY` must match private `engineControl/queueRollout` (`schemaVersion: 1`, `policy: legacy` or `fair-queue-v1`). Missing control permits legacy only. All admitting/claiming processes must first run the fence-aware version. To switch either direction: stop new admission, drain pending and processing jobs, stop the old workers, verify the required index, change the fleet control and process configuration together, then resume. Old deployed binaries cannot be fenced by code they do not contain. Never rewrite queued assignments or reset failed jobs.

Selection v2 is an existing server capability, not a feature that can safely be downgraded with a cohort toggle. New jobs record it; old jobs retain their recorded compatibility path. Client selection recovery rolls out in the Android build. X and manual Retry semantics remain mandatory.

`ENGINE_PRICE_TABLE_JSON` supplies a dated price table. No live vendor rates were invented. Missing/invalid usage or pricing remains unavailable in reports; an invalid price configuration cannot prevent a save. Stage durations may overlap. Queue-expired/admission-rejected jobs have explicit missing processing duration and are included in reporting. Costs describe instrumented work and need invoice reconciliation; they are not measured total infrastructure spend.

## Verification and adversarial review

Independent Codex CLI subagents implemented bounded packages and separately reviewed them. Review found and led to fixes for cross-account asynchronous saves, stale shared snapshots, replayed selections, lost dismissal, cross-owner pin-ID reuse, oversized event/index records, false multi-place completion, blocked-subtitle provenance, misleading queue flags, missing queue failure measurements, and invalid configuration leaving work stuck.

Local integration checks passed: server 941 tests across 71 suites; separate Functions package 13 tests; app typecheck and 756 tests across 60 suites; Firestore rules 213 tests across 7 suites. Real Firestore SDK accounting/migration checks passed. Two actual fair-worker processes completed 70 jobs with a peak of four globally and one per account, including eligible users beyond the first 50 rows. All 32 synthetic processing regressions passed. Android JavaScript/assets export and the production Node entry smoke passed. These checks use stubbed extraction and synthetic credentials, not paid providers.

Server independent re-review approved fleet/configuration/terminal metrics, accounting repair, baseline separation, subtitle failure handling and the stale-match fix. An additional regression ensures that a failed source write cannot mark later, unattempted attachments as saved. Final independent app re-review approved owner-scoped selection recovery, original source metadata preservation and shared-list listener recovery; its remaining rules caveat was subsequently covered by the successful 213-test emulator run. These approvals are scoped code reviews, not physical-device or production validation.

No live Instagram/TikTok scraping, provider billing, production credentials, deployment, backfill, or new installable Android preview has been performed at this checkpoint. There is no local Android SDK/device or Docker runtime available for physical lifecycle/container validation. CI contains the clean Docker build and entry-point smoke gate; a local JavaScript export is not a substitute.

## Review branches and hosted checks

- App implementation: `92c98c1`, branch `feat/engine-next-improvements`, checkout `/Users/alexlin/workspace/mapd-next`. [Draft PR #13](https://github.com/a13xlin96/mapd/pull/13) includes the prior unmerged onboarding, thumbnail, share and retry fixes. [GitHub run 34867448029](https://github.com/a13xlin96/mapd/actions/runs/34867448029) passed all three jobs: checks, rules and Android export.
- Server implementation: `7377d1a`, same branch name, checkout `/Users/alexlin/workspace/mapd-server-next`. It includes the prior unmerged thumbnail and extraction changes. Publication to the public server repository was blocked by automatic approval review pending explicit user approval to upload this code/history. Server hosted/container CI has therefore not run.
- The Expo Android preview upload/build was separately blocked by automatic approval review pending explicit user approval for this branch upload and potential build credits. No installable APK has been produced for these changes.
- Local provenance archives and a manifest identify the tested Android JavaScript/assets export and server source archive. They are not an APK or container image, and do not establish deployment.
- Both original checkouts remain intact. No merge, production deployment, data migration or behavioral-history deletion was performed.

## Operator sequence after code review

1. Confirm deployed app/server revisions, supported clients, actual Firebase project, Storage configuration and existing indexes. The baseline includes earlier thumbnail work; do not assume its infrastructure is deployed.
2. Run clean CI, including the production container build/smoke. Deploy additive rules/indexes and the new accounting triggers, then initialize capture. Use the exact project explicitly; deployment scripts otherwise inherit Firebase CLI defaults.
3. Review migration output, backfill in bounded pages, repair deliveries and verify parity. Activate each account only after a successful comparison. Preserve the cutover timestamp and legacy history.
4. Deploy the compatible service after capture is working, with language and new readers off. Release an installable Android preview; verify the device matrix below. Enable readers only for validated accounts.
5. Collect independently checked real evidence before language/accuracy expansion. Use internal accounts, then 5%, 25%, 100%, with at least 24 hours plus sufficient reviewed outcomes at each step. Fair queue changes use the separate drain procedure.
6. Keep release manifests with artifact hashes, source revisions, rules/index revisions, migration output, reviews and comparison reports. Roll back optional readers/new admission behavior without deleting history or restarting failed attempts.

Commands below are operator templates, not commands already executed. Replace `PROJECT_ID` and `USER_ID` explicitly:

```bash
npm --prefix functions run deploy:accounting -- --project PROJECT_ID
node scripts/accounting-migrate.js --project PROJECT_ID --uid USER_ID --initialize-capture
node scripts/accounting-migrate.js --project PROJECT_ID --uid USER_ID --initialize-capture --apply
node scripts/accounting-migrate.js --project PROJECT_ID --uid USER_ID
node scripts/accounting-migrate.js --project PROJECT_ID --uid USER_ID --apply
node scripts/accounting-repair.js --project PROJECT_ID --uid USER_ID
node scripts/accounting-repair.js --project PROJECT_ID --uid USER_ID --apply
node scripts/accounting-migrate.js --project PROJECT_ID --uid USER_ID --activate --apply
```

Backfill resumes its stored checkpoint. Repair outputs an opaque `nextCursor`; pass it using `--cursor` with the same project/account/mode. Start another scan from the beginning for newly inserted inbox records. `needs_review` requires explicit `--retry-needs-review`; missing accounts and disabled capture remain recoverable. Reports exclude raw URLs and event payloads. These tools never purge analytics or run social extraction.

## Remaining release evidence

- Physical Android: signed-in cold start in airplane mode; browsing saved owned lists; tab changes; logout/account switch during reads/saves; deletion then restart; expired/evicted images; native cache/backup behavior.
- Recovery: unfinished choice stays in Activity until tapped; offline confirmation explains connection requirement; kill during commit then confirm again produces one pin/source; X survives restart and same-account login; failed links remain stopped until Retry.
- Legacy selection uses an owner-scoped lock and a bounded owner/place lookup. A deleted, moved or foreign lock target fails safely instead of silently recreating a pin. Automatic stale-lock repair is not implemented; manual add/dismiss remains available. The lock coordinates selection recovery writers, not every historical client writer.
- Real corpus: 100 independently labeled development posts and 50 sealed evaluation posts, plus a small separately authorized live accessibility sample. The two previously reported Instagram failures belong in regression, not the blind set. No live recall, wrong-place improvement, cost reduction or population-wide accuracy claim is established by the synthetic suite.
- Production shadow/parity and invoice comparisons, actual deployed indexes/configuration, clean container CI and installable preview provenance.

These are explicit release gates. Local implementation and passing tests alone do not mark production rollout complete.
