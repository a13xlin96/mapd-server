# Processing recovery implementation — September 27, 2026

## Delivered code

1. AI answer handling now accepts limited harmless framing around one complete JSON result, while rejecting truncation, ambiguous objects, duplicate keys, malformed venues, and injected trusted fields. Redundant counts are calculated from the validated venue list. Private bounded rejection reasons do not expose model text. Text-AI cache identity changes so previous extraction results are not mistaken for results from the corrected prompt. No paid repair request or automatic provider retry is added.
2. Explicit retry of an unverified venue name gathers fresh evidence and can enter selective media recovery when enabled. Confirmed save retries retain exact Place IDs and stored coordinates, avoid repeated AI/Google matching, and preserve saved and dismissed outcomes. Distinct same-name branches survive deduplication and media merging. Mixed source/image/media failures retain unfinished work without preventing independent confirmed saves. Unrestricted whole-post fallback cannot override a prior selection or dismissal.
3. Generic food/award/price language is treated as context in extraction instructions; there is no word blacklist and no weakening of location matching. Negative Google search results expire after five minutes and an explicit retry can refresh them; successful cached matches remain reusable.
4. Activity cards derive the ready-place count from distinct Place IDs and valid numeric coordinates. Verified, unverified, mixed, legacy, and partially saved results receive appropriate wording. A nullable local queue field survives restart; terminal transitions clear stale counts. Choose, Retry, Add manually, and X keep existing guards. No automatic failed-job retry or dismissal resurrection was introduced.

## Review

Separate workers implemented response parsing and app presentation; the parent implemented retry integration. Independent reviews found and corrected: redundant-count rejection, distinct selected-ID collapse, unsafe OG fallback on retry, lost unresolved siblings after carousel failure, and source failure blocking an independent selected save. Additional tests cover failed-save snapshots, interrupted selections, mixed fresh/confirmed work, explicit analysis retries, and stopped attempts. The app review found no remaining concrete defect; coordinate range checks were added during parent review. A further independent review found that a stopped worker could lose retry authority before saving a checkpoint. Recovered outcomes, exact candidate snapshots, dismissals and inherited media recovery are now checkpointed together before fallible analysis. Regressions reproduce interruption followed by the stale-job sweeper and another explicit retry. Final server re-review approved the fix and independently ran both interruption regressions on Node 20: 2 passed.

## Validation

- Server complete root suite on production-aligned Node 20: 1,933 passed, 34 skipped, 121 passing suites. Skips are existing opt-in suites; no claim is made that they ran.
- App complete suite: 1,211 passed in 80 suites.
- App TypeScript check: passed.
- Offline engine regression: 32/32 scenarios passed.
- Scoped diff/whitespace checks: passed.
- One full run observed an unexpected 405 instead of 401 in the local unauthenticated vision-route HTTP test. Its isolated Node 20 rerun passed all 11 tests without changes. No production route modification was made to mask it; the confirmed full rerun is retained separately.
- No Firestore rules changes. Providers were mocked for automated tests.
- Native visual/touch and installed-device SQLite upgrade testing were not possible here. Rendered component/action and persistence tests passed.

These tests do not establish real-video recognition accuracy or guarantee that the original lost malformed AI response is now accepted.

## Media pilot: readiness improved, activation still outstanding

A one-off check of Ddu8iwqyxgP with yt-dlp 2026.08.19 (the production-pinned version) found caption and a direct video descriptor in 2.485 seconds on this Mac. No media bytes were downloaded, no paid AI inference ran, no pins/jobs were written, and no automatic retry ran. This is source-discovery evidence, not recognition or Render-network evidence.

A narrowly scoped Render UI check confirmed both provider-key variable names are present and ENGINE_ROLLOUT_JSON is absent. Values were not revealed or copied. Earlier evidence includes pinned transcription model access and generated decoder tests, but no real-video audio/sign recognition result. Production media controls and user enrollment remain unchanged.

Real validation needs a supported execution channel with provider credentials and decoders. The existing HTTP API has no no-save multimodal diagnostic endpoint; the known free-plan Render Shell is unavailable; local provider credentials and decoder binaries are absent. Do not enable public media rollout, mislabel this as a live recognition pass, or run historical failed jobs to work around that gap. A small manually invoked diagnostic in the trusted server environment is the remaining operational step; owner-only enrollment follows a successful check. Monetary controls remain observation-only.

## Integration and release

Only this change set is copied into the existing mapd-next and mapd-server-next working directories after comparing original file hashes. Existing dirty work is preserved. This execution does not commit, publish, deploy, start a mobile build, change rollout flags, or retry user jobs. Server publication is needed for engine behavior to change; a new mobile release is needed for Activity wording. Old failed jobs remain untouched until an explicit user retry.

The implementation plan is `processing-recovery-plan-2026-09-27.md`. Private logs, original hash inventories, source-check output, reviewer handoffs, and integration inventory are under `/private/tmp/mapd-recovery-20260927-5aEDe4`.
