**Mapd: four engine cost and reliability fixes — implementation plan**

Drafted September 18, 2026. Implementation authorized September 18 with a user override: build spending infrastructure in observation mode only. No spending limits or monetary rejection paths are enabled; observation failures must not interrupt processing. Production deployment is a separate action.

The four changes are: F1, fetch rich Google place details only for committed saves; F2, share identical in-progress AI work; F3, preserve the longest provider cooldown; F4, record spending and build policy infrastructure without enforcing limits. Recommended execution order: **F3 → F2 → F4 → F1**. The smaller reliability fixes come first; deferred details then use the same spending observations.

Audio transcription, video-frame extraction, model changes, the color/UI work, and publishing mobile builds are outside this plan. Existing app changes remain intact. The budget mechanism should support additional provider operations later without enabling them now.

**1. Baseline and requirements**

Inspected server: `/Users/alexlin/workspace/mapd-server-next`, commit `dd145e7`. App: `/Users/alexlin/workspace/mapd-next`, with existing uncommitted compact-card, theme, and selection improvements. These are checkout observations, not verification of deployed versions or configuration.

Relevant existing behavior:

- `enrich.js:851–899` searches and fetches full details for each new candidate before selection. `enrich/places.js` requests Enterprise + Atmosphere details.
- `enrich/ai.js` caches successful AI responses but allows simultaneous misses to call the provider independently. Source extraction already has separate request coalescing; preserve it.
- `lib/providerRuntime.js:46–52` overwrites cooldown deadlines; its capacity checks already occur before and after acquiring a provider slot.
- `lib/enrichAdmission.js` limits outstanding jobs. It does not enforce cumulative monetary spending. Direct compatibility AI routes also need a billing context.
- `functions/index.js` retries dispatch on 429/5xx. Budget denial must not enter that retry path.
- App `resolveCandidateExtensions` treats missing `businessStatus` as an old server and can fetch details itself. Intentionally deferred details need an explicit contract.
- `functions/lib/pinAccounting.js` derives save history and counters from committed pin mutations. Ordinary metadata updates currently do not create another save, but also do not refine the immutable original save facts or latest-profile fields automatically.

Acceptance invariants across all four fixes:

- A failed or dismissed share never restarts automatically. Cooldown expiry, budget reset, app reopening, and cache expiry do not enqueue it again.
- A committed pin stays saved even if optional enrichment fails. Save confirmation waits for the durable pin write, not optional details.
- User selections, source links, user-edited fields, and existing counters remain correct. Partial success stays visible and recoverable without redoing successful saves.
- Public post evidence can be shared across accounts; personal notes, user-specific evidence, pin IDs, and account data cannot.
- Spending observations apply to real server provider requests, including compatibility routes and maintenance jobs. Cache hits and followers incur no physical-call observation. No spending limits, reservations, or budget denials are active.
- No claim of exactly-once external billing: an ambiguous timeout can still have been billed. Record that uncertainty conservatively.

**2. F3 — preserve provider cooldowns**

**Result:** a response asking for a short wait can never erase a longer active wait.

Implementation:

1. Extract a small cooldown store from `providerRuntime.js`. Keep the existing provider grouping initially; do not silently change Instagram/TikTok/API-key isolation in this patch.
2. In one Redis atomic operation, use a consistent store clock and set `until = max(existingUntil, now + retryAfter)`. Set expiration to cover that resulting deadline, not the newest response's shorter duration. Preserve existing retry-after parsing, default duration, and maximum bound.
3. Apply the same maximum rule in the explicit single-process development fallback. Distributed production must not silently switch coordination to process-local state.
4. Preserve both admission checks. Do not hold a provider slot while waiting out a long cooldown; return the typed terminal failure to the current attempt.
5. Stop swallowing failures to persist a cooldown. Surface a coordination error and private diagnostic; refuse fresh uncached requests when coordination cannot be trusted. Expiration itself schedules nothing.

Files: `lib/providerRuntime.js`, proposed `lib/providerCooldown.js`, `tests/engine.provider.test.js`, `tests/engine.redis.test.js`.

Acceptance tests: long-then-short and short-then-long responses; simultaneous writes from two processes; clock skew; expiration covering the maximum deadline; missing/malformed retry-after; Redis outage; correct explicit single-process fallback; zero provider calls during the wait; no job restart after expiry.

**3. F2 — share identical in-progress AI requests**

**Result:** simultaneous callers with identical eligible evidence receive one validated result from one paid call.

Implementation:

1. Introduce `lib/sharedAiOperation.js`. Identity includes operation kind, normalized full input, model, prompt/schema/options versions, and trusted privacy scope. Cover extraction, single-place extraction/verification, carousel vision, and inline region inference. Never group different operations just because they refer to the same URL.
2. Only server-fetched public evidence receives public scope. Compatibility routes derive private scope from verified auth. Missing scope means request isolation, never a common `uncached` bucket. Vision identity must incorporate the actual bounded image inputs/content digests and order; changing signed URLs must not become the sole identity.
3. Use a process-local promise map for callers within one process. For cross-process ownership, use a server-only Firestore operation record with transactional generation/owner/lease state and a durable dispatch marker. This reuses an existing durable datastore and avoids treating an evicted Redis key as proof that no paid request ran. Redis remains the ordinary result cache and provider-capacity/cooldown store.
4. Recheck the completed cache after claiming leadership. Followers observe the same operation generation; use one bounded watcher per operation per process rather than polling separately for every caller. Followers hold neither provider slots nor budget reservations. Bound follower count, watcher lifetime, result size, and wait duration.
5. Separate shared-operation execution from the initiating share's `jobContext`. Each caller independently checks cancellation, deadline, and ownership before joining and before using the result. Cancelling one caller cannot abort work required by another. Shared completion never authorizes a cancelled caller to save.
6. Authorize dispatch in a Firestore transaction that verifies the current operation owner/generation, links its unique spending observation for audit, and records the one permitted dispatch identity. A spending observation never authorizes a stale producer. Once dispatch is marked, another producer cannot replace it and send again. Publish success only under the current owner/generation after schema validation. Share a typed failure with current followers; do not cache provider failure as a valid empty place list. Short-lived coordination outcomes and ordinary successful-cache TTLs are separate.
7. A pre-dispatch abandoned leader can be replaced transactionally. After dispatch, lease expiry/crash becomes `uncertain`; it must not silently trigger a second paid call. A new explicit retry can create a new authorized generation. Stale workers cannot publish or delete a replacement owner's state.
8. Preserve explicit refresh semantics: bypass ignores completed cache entries, while identical simultaneous refresh requests may join the same fresh generation. It must not reuse a stale normal generation. Avoid persisting raw evidence in coordination records; store hashed identities, bounded results, and operational metadata with retention cleanup.

Files: proposed `lib/sharedAiOperation.js`, `enrich/ai.js`, `lib/vision.js`, `lib/jobContext.js`, `index.js`, relevant cache/AI/HTTP tests. Reuse rather than rewrite existing extraction coordination. Private Firestore records remain inaccessible to clients.

Acceptance tests: three identical calls produce one provider call, including across two processes; a later warm call produces zero; different private users and changed evidence/models do not share; identical public evidence does; independent caller cancellation; leader crash before/after dispatch; stale publication; result-cache outage; malformed provider JSON; bypass generations; deadline cleanup; no leakage of raw private evidence. Pause producer A before dispatch, replace its expired pre-dispatch lease with B, then resume A: only B can dispatch. Redis eviction and Firestore transaction retries cannot create duplicate dispatches or spending observations. Measure additional datastore calls and follower latency alongside avoided AI calls.

**4. F4 — spending infrastructure in observation mode (user override)**

**Result:** account/attempt/global spending visibility and validated policy helpers, without limiting processing. This replaces the original enforcement phase for this execution.

Implementation:

1. Route server Anthropic/Google calls through `providerRuntime` with trusted auth/job attribution, operation/SKU and model descriptors. Maintenance calls receive a service identity. Cache hits and shared followers never count as paid requests.
2. Add `engineBudget.js` and `engineBudgetPolicy.js`. Runtime mode is fixed to `observe`; even a supplied future policy containing caps or an emergency stop cannot deny dispatch. Policy validation and prospective allowance calculations are isolated pure helpers, not runtime authorization.
3. Record a unique physical-call observation with integer microdollar estimates, model/token bounds, dispatch timestamp, eventual usage, and uncertainty. Dispatch time is captured synchronously; datastore work is asynchronous and never awaited by the provider path. Missing storage, rates, usage or identity is diagnostic, never zero-cost or permission to block.
4. Use Firestore transactions to update idempotent per-call records plus separate account, attempt, and global daily/lifetime counters. Never add these dimensions together as if they were different charges. Preserve original UTC dispatch day, uncertain liabilities and prior-day risk. Refunds/corrections require a separate future reconciliation flow.
5. Link the observation ID to shared-operation dispatch records for audit only. Shared-operation ownership remains the dispatch authority; a spending observation grants none.
6. Keep records private under `engineSpendCalls` and `engineSpendCounters`. Do not persist prompts, images, URLs, raw user IDs, raw attempt IDs or provider error bodies. Unresolved accounting records have no automatic TTL.
7. Add meaningful tests for duplicate/out-of-order observations, missing rates/usage, timeout/unknown billing, midnight boundaries, malformed configuration, ledger outages, and a stalled ledger during a successful physical request.

Observation is an estimate, not an invoice. Crashes and storage outages can leave gaps. Prices are versioned list-rate assumptions; actual provider usage, discounts and invoices remain the reconciliation source. Existing older mobile Google calls outside the server are not covered. Server source-fetch operations have unknown external price rather than an invented free price.

**Future enforcement is explicitly out of scope.** Activating caps later requires atomic reservations and dispatch authorization, a reviewed fleet migration, uncertainty reconciliation and a separate user decision. No environment variable flips this implementation into enforcement.

**5. F1 — defer rich details until a place is saved**

**Result:** search-verified choices appear without fetching optional details for every candidate; saved places receive their details through durable enrichment with spending observation.

Planned flow:

`Extract evidence → Google search/branch validation → show basic candidates → commit selected pins and detail tasks → confirm save → load rich details independently`

Implementation:

1. Separate verified core fields from optional business attributes. Core fields include stable place ID, name, address, coordinates, source evidence, and category/location supported by search. Do not invent missing structured geography. Reuse fresh details already in cache without a new paid request. Preserve any details needed for a specific branch-validation decision; record that exception separately from optional enrichment.
2. Build candidates without uncached rich-detail requests across AI, fallback, and Google-link paths. Show rating/hours as unknown when unavailable. Keep current field keys with explicit nulls where older clients expect them, including `businessStatus`; add an optional `detailsSchemaVersion`/`detailsState` discriminator rather than blindly incrementing `engineVersion.schema` (the app currently routes schema 2 selections specially).
3. When a pin is actually committed, create its private detail-task/outbox entry in the same transaction. Key it to the pin's server-controlled creation generation, place ID, and details schema. For a newly created pin, compare the queued task snapshot's update time with the pin's creation time, then persist that pin generation; do not trust a client-writable `createdAt` or generation flag. For an existing pin, record its actual creation generation from the transaction's read. The worker verifies that generation before dispatch and application, including deletion/recreation before the first claim. Unselected candidates and abandoned modals create no task. Existing complete pins do not refetch details when another source is attached.
4. Introduce a bounded detail worker that uses the same provider wrapper, shared fresh Places cache/miss coordination, and spending observation. Start with one details request in flight per worker, within the shared global provider limits. Use fair scheduling and do not starve interactive processing. Initial jobs are durable across server restarts; perform at most one paid attempt per task generation unless the user explicitly requests another.
5. Task states: `queued`, `running`, `complete`, `needs_action`, `cancelled`, with generation/owner/deadline and sanitized reason. Infrastructure redelivery may recover an unstarted task; it must not repeat an uncertain dispatched request. Google failure makes details incomplete, not the pin/save unsuccessful. Do not reopen a completed shared-link card. Provide a small owner-only explicit detail retry action when needed.
6. Apply enrichment in a transaction only if the account/pin still exists and owner, place ID, creation generation, and task generation match. Patch an allowlist of provider-derived fields. Do not overwrite user notes, lists, visits, source links, selected category, or a manually corrected place. Preserve user edits using provenance/compare-before-update. Never recreate a deleted pin or downgrade already richer data with missing fields.
7. Preserve phase-two data: extend the committed-pin handler in `functions/lib/pinAccounting.js` with a focused metadata-contribution helper. Store one versioned private contribution per owner/pin/creation generation, containing derived category, geography, business attributes, and trip attribution. Compare the previous/current contribution and apply only its delta. This is the concrete consumer of the enrichment update, not just an event nobody reads. Enrich the profile's current-place features and, when it still refers to this exact most-recent pin/generation, its latest-save category/city/country summary. A late completion cannot replace a newer save's summary. For missing or corrected provisional trip geography, assign or transfer the original pin's one contribution to the correct trip projection; do not increment overall verified saves or count that pin twice. Preserve user-selected category/location overrides. Keep original save history and `tripSignalIdAtSave` immutable; corrected current attribution is a separate projection with provenance. Metadata events and duplicate/out-of-order trigger deliveries must converge through this helper rather than `recordPinSaved`.
8. Update app types/parsing, candidate compatibility, detail rendering, and explicit retry handling. Deferred fields must not activate `resolveCandidateExtensions`' old-server refetch or a legacy client-side Google call. Retain older completed/full candidate payloads. Test both the server-selection path and legacy selection compatibility; initially gate new deferred jobs to verified compatible release cohorts if an older client cannot safely handle the contract.
9. Keep detail-task authority private. Clients may request retry through an authenticated owner-checked endpoint but cannot create tasks, reset attempts, alter their generation, or choose arbitrary billable field masks. Any public-facing status is a projection and never sufficient authority to dispatch a paid request.

Files: `enrich.js`, `enrich/places.js`, proposed `lib/pinDetails.js` and `lib/pinDetailsWorker.js`, `functions/lib/pinAccounting.js` and its tests, app `src/services/enrichmentJobsListener.ts`, `src/types/index.ts`, `src/stores/pinsStore.ts`, `src/components/PinDetailSheet.tsx`, related service/failure tests, Firestore rules/indexes as required.

Acceptance tests: ten uncached candidates with three selected produce zero optional detail calls before selection and three afterward; choosing none produces zero; choosing all ten still fetches ten; cache hits and same-place concurrent saves avoid duplicate lookups; server crash immediately after save does not lose the task; all detail failures leave committed pins saved; pin/account deletion and place correction prevent stale application; user edits survive; repeated task delivery updates metadata once; counts/save history/interests do not duplicate; late metadata cannot overwrite a newer profile summary; old/new clients and existing selection jobs behave correctly; no share reprocessing or Activity-card resurrection. Save with missing/provisional geography and category, then hydrate: current profile/trip attributes converge, the pin contributes once, and immutable history/user choices remain intact. Repeat with duplicate, reversed, and stale-generation trigger delivery.

Illustrative savings: at $0.025 per uncached rich-details request, ten requests cost $0.25 versus $0.075 for three, saving $0.175. Search charges remain. All-ten-selected saves no detail-request fees. Measure worker/datastore overhead as well; do not present this example as an observed invoice reduction. Revalidate rates before rollout using [Google's pricing](https://developers.google.com/maps/billing-and-pricing/pricing).

**6. Delivery packages, verification, and rollout**

| Package | Scope | Depends on | Completion evidence |
|---|---|---|---|
| P0 | Capture baseline call inventory, contracts, fixture counts, stage latency and cost visibility | Existing checkout | All paid paths classified; unknown costs listed |
| P1 | F3 cooldown fix | P0 | Two-process races preserve maximum deadline; no automatic replay |
| P2 | F2 shared AI operation lifecycle | P1 | One dispatch across simultaneous identical callers; privacy/cancellation/crash cases pass |
| P3 | F4 observation ledger, policy helpers and provider adapters | P2 | No configured cap or telemetry failure rejects processing; physical calls reconcile idempotently |
| P4 | F1 deferred details, durable worker, app compatibility and metadata accounting | P3 | Selection call-count, durable-save, old-client and accounting tests pass |
| P5 | Independent adversarial review, staged rollout and measurement | P1–P4 | Findings resolved; version/flag evidence and before/after metrics recorded |

Subagent execution boundaries: one worker owns provider/cooldown/shared-operation modules; one owns budget ledger/policy tests; one owns deferred-details/app compatibility. The integrator owns overlapping `providerRuntime.js`, `enrich.js`, and rollout contracts. Parallel work begins only after shared interfaces are agreed; avoid concurrent edits to those files. A separate reviewer challenges cancellation, privacy, partial saves, ledger bypasses, and ambiguous external billing.

Verification uses local provider stubs first; no paid corpus replay is necessary to prove these four fixes. Run server `npm run test:ci`, `npm run test:contracts`, `npm run evaluate:engine`, and the existing load/emulator suites augmented with the new cross-process cases. Run Functions `npm run test:ci` from `functions/`. Run app `npm run typecheck`, `npm run test:ci`, and `npm run test:rules` with Java 21+. For app-facing changes, verify actual components/flows and export Android and iOS bundles. Report measured timings separately from simulated delay tests; no unsupported speed percentage.

Rollout sequence:

1. Deploy compatible readers/failure handling and private schemas while new detail behavior is disabled. Enable F3 and F2 on a small controlled cohort, checking error rate, latency, saved outcomes, and actual provider-call counts.
2. Observe spending with real rate configuration. Measure ledger contention, unknown costs and datastore overhead. Keep all spending limits disabled as requested.
3. Review rollout evidence before changing processing cohorts. Any future budget enforcement requires a separately authorized implementation and migration; it is not part of this release.
4. Enable deferred details internally, then at 5%, 25%, and 100% only after client compatibility and durable-task checks pass. Record behavior/version on new jobs; do not reinterpret old selection payloads.
5. Compare time to choices, time to confirmed save, optional-detail completion/failure, calls per candidate versus saved place, duplicate-call rate, unknown spending, uncertain liabilities, and provider reconciliation. Do not claim improved venue-recognition accuracy from these cost/reliability changes.

Rollback: disable new shared/deferred behavior without rewriting terminal jobs or deleting spending observations, cached results, saved pins, or queued task records. Keep the compatible details worker available to drain already committed tasks, or pause it explicitly with saved pins intact. Spending observation has no enforcement switch or limits to bypass. No automatic reprocessing of failed/dismissed shares and no bulk backfill of historic pins in this release.

Final implementation handoff must include changed files, all verification results, known limitations, compatibility matrix, observed spending coverage, the observation-only spending configuration, and resolved adversarial findings. Production deployment and paid rollout remain separate actions from this implementation task.

**Implementation notes — September 18**

The code is implemented in the server and app working copies; production deployment, credential changes and mobile build publication are not part of this execution. Spending remains observation-only. The existing provider concurrency/rate-limit safeguards remain in place.

- Optional details now use a private atomic outbox. The queued private outbox snapshot's `updateTime` commit metadata binds the first claim to the pin's real `createTime`, including when a task document ID is reused. Explicit retries require both the task's unique ID and its revision, so delayed requests cannot target a deleted/recreated pin.
- The details worker starts alongside the existing enrichment worker, with one local optional-details request in flight. Indexes on task status/creation and status/deadline must be deployed first. Deploy the shared-operation `expireAt` TTL configuration as well; the code does not directly purge records.
- `detailsSchemaVersion:1` and `detailsState` distinguish intentional missing details from old server payloads. Selection remains schema 2. Existing complete candidates and legacy selection remain supported; old pin records do not gain invented pending state. Only saved pins get outbox tasks; there is no historical-pin backfill.
- Original comparison baselines and atomic unions of user-edit markers protect corrections across retries and devices. Sparse provider objects merge known values rather than erasing previous attributes. The open detail sheet and its directions/category actions consume the same live pin.
- Shared operations track expiring process subscriptions before dispatch. Cancelling the final interested caller removes permission for a new paid call, while a remaining caller on another server keeps its work. Refresh requests waiting on one normal generation share that generation's first refresh successor. Network partitions remain bounded by subscription expiry and shared deadlines.
- Current recommendation metadata has its own per-pin generation pointer under the private interest profile. Older Functions writers cannot erase that pointer during rollout. Save history and verified-save counts stay separate from metadata updates.
- All observation writes are outside the provider critical path. Missing usage, exceeded estimate bounds and numeric overflow remain unknown liabilities. Account/attempt/global totals are separate views of the same charges, not additive bills. Configured monetary limits cannot affect dispatch in this release.

Rollout prerequisites: publish indexes/TTL, deploy compatible Functions and server code, and distribute the updated app for live metadata/retry UI. Confirm those versions before testing actual links. No live provider replay or measured production latency claim is included in local verification.

Deployment clarification: the new shared-operation and deferred-details paths are active in this code; this patch does not add percentage rollout controls for them. The cohort sequence above is an operational rollout proposal, not an existing switch. Validate the combined release in staging before production. A rollback needs the matching code release and a deliberate decision about draining committed detail tasks; there is no monetary enforcement switch.

**Local verification — September 18**

- Server: 1,188 tests passed across 87 suites. The 11 emulator-only tests are skipped by the ordinary command and were run separately against Firestore: all 11 passed.
- App: 960 tests passed across 73 suites; TypeScript passed. Firestore rules: 225 tests passed across 8 suites, including direct-client denial for the new private collections.
- Functions package: 13 tests passed. The real Firestore accounting integration also passed.
- Real Firestore plus independent Node processes: nine equivalent public callers caused one stub provider call; two different private users caused two separate calls. Separate process tests cover producer cancellation with and without a remaining remote subscriber.
- Offline engine evaluation: 32 synthetic scenarios passed. Provider load test: 10 calls across two processes respected peak concurrency of one using local coordination stubs.
- Android and iOS JavaScript bundle exports passed. The actual retry component was checked at 320px width with 160% text sizing, including successful retry, error, and repeated-tap behavior.
- Independent adversarial reviews found and prompted fixes for task/pin recreation binding, stale retry tokens, old Functions writers replacing metadata accounting markers, incomplete cost bounds, cancelled shared requests, overlapping refresh generations, and a malformed-input HTTP handler. Added regression tests exercise these cases. Final independent rereviews approved the deferred-details lifecycle and shared-request fixes; no reported blockers remain.

Limits of verification: providers were stubbed; no paid live-link replay, production latency benchmark, native device run, deployment, or mobile build publication was performed. Real Redis Lua execution was not available locally; cooldown atomic semantics were covered with datastore stubs. Spending observations are estimates with outage/crash gaps, not guaranteed invoice reconciliation. A remote cancellation after the final fenced demand check retains the unavoidable network send-time race; already-dispatched provider work cannot be made free by cancellation.
