**Mapd engine implementation plan — September 13, 2026**

Improve the number of correctly saved places, explain failures accurately, and reduce repeated work as usage grows. This covers the remaining link-processor findings in the [engine review](/Users/alexlin/workspace/mapd-server/docs/engine-review-2026-09-13.md). The original design is retained below; the execution status and current flow here describe the implementation completed September 14.

**Execution status — September 14, 2026**

Implemented locally in the server and Android app. Nothing in this change has been deployed, and no new installable APK has been built. Engine version: `2026-09-14.1`; prompt `places-5`; job schema `2`.

| Phase | Implemented | Remaining release or evaluation work |
|---|---|---|
| E0 | 32 deterministic regression fixtures; saved 12/32 baseline; current 32/32; engine, model, extractor and schema stamps on new jobs | Live precision/recall, stage latency and cost calibration. The named holdout subset was inspected during implementation and is not a blind evaluation. |
| E1 | Typed failures through the worker, Activity and push; errors do not masquerade as valid empty AI results | Verify real provider responses and user-facing messages on a phone. |
| E2 | Full bounded text context; private/public cache separation; strict AI response validation; HTML parser; same-post account tags and collaboration evidence | Live Instagram can omit or block metadata. Coverage is recorded; profile pages are not scraped to guess account identity. |
| E3 | Shared extraction and short-link coalescing; shared provider leases/cooldowns; pinned extractor dependencies; safe bounded fetching | Test the Docker image and real Redis/Render configuration. Repeated source rejection can still happen; no request rate is guaranteed safe. |
| E4 | Ranked matches with geographic rejection, confirmation for tags/uncertain geography, basic-place fallback when optional details fail, partial-save progress and explicit Retry remaining | Android device tests for selection, interrupted saves and cold-start restoration. Original-language names are preserved, but cross-language alias matching is not universal. |
| E5 | Durable admission, transactionally owned execution, per-user/global limits, deadlines, stale-job finalization, recent indexed listener plus exact local reconciliation | Production latency/capacity measurements and operational rollout. The two-process test uses a simulated Redis service and stubbed provider, not production load. |
| E6 | Existing carousel analysis retained with resource bounds | New video-frame/audio processing is not implemented or enabled. The optional pilot is deferred. It requires accessible media and measured accuracy/cost evidence before enabling. |

The adversarial review and final checks are recorded in [the implementation review](/Users/alexlin/workspace/mapd-server/docs/engine-adversarial-review-2026-09-14.md).

**Current flow in plain language**

1. Save the shared link and accompanying text on the phone. Submit one authenticated job. The server records it before acknowledging it.
2. A worker takes ownership within a bounded wait. Existing saved places are checked before expensive work. A failed job is never picked up again.
3. Reuse a successful public-post extraction or read the source under shared limits. A 429 starts a cooldown and ends that source attempt; it does not trigger a barrage of alternative readers. Private text stays isolated to that user.
4. Give the AI the available caption, shared text, subtitles, hashtags and account tags, with their origins. Available matching-post tags and collaborators are included. A creator or friend is not assumed to be a restaurant. Existing photo carousels also receive bounded image analysis.
5. Compare up to five Google candidates for each extracted name. Reject geographic contradictions; ask the user to choose when a tag, missing geography or competing branches leave doubt. Missing optional hours/rating data does not erase an otherwise valid place.
6. Save confirmed places with transactional deduplication. Show any unresolved portion as a persistent partial failure. Retry creates a new attempt tied to the old one and retains successful pins. X removes the failed card persistently.

**Concrete release sequence**

- Review and deploy the additive `retryOf` rule and the checked-in enrichment-job indexes in the app repository. Wait for indexes to be ready before rolling out the bounded listener and deadline sweeper. Reconcile indexes already in production; do not delete unrelated indexes.
- Build and verify the server image with pinned yt-dlp/curl dependencies. Configure shared Upstash Redis for production. An explicit `ENGINE_SINGLE_PROCESS=true` fallback is only appropriate for a deliberately single-process deployment; it is not a scaling configuration.
- Release the compatible server contracts before the new Android client. New schema-2 selections use `/enrich/selection`; older jobs retain the app's legacy selection path. Start with internal testing. This implementation does not add per-account rollout flags; use a separate test deployment/build for the initial cohort.
- Build an Android preview and test real cold-start sharing, one and multiple places, tag-only confirmation, Retry remaining, X, app restart, and a temporary network failure. Check that already saved pins and counters are not duplicated.
- Keep the optional new media pilot off. Measure actual accuracy, delay and cost before enabling it or raising concurrency. Do not automatically replay historical failures. Recommendation/ads telemetry collections are retained.
- Treat the already-present thumbnail-persistence branch work as a separate deployment dependency: verify its Storage configuration independently. Rollback must preserve committed pins and failure/dismissal records; never clear the shared Redis database as a shortcut.

**Starting point and fixed requirements**

The app's manual Retry and persistent X dismissal are implemented in `03ad6a7`. The last verification passed 707 app tests, type checking, and Android bundle compilation; the actual phone still needs the new build and device verification. Server review baseline is local `1a21ce2`, which includes a separate thumbnail change. Confirm the deployed server revision before implementation; local branch contents do not establish what is live.

- Once an attempt is failed, it stays stopped. Foregrounding, reconnecting, a worker restart, or expiry of a provider cooldown must not restart it. Only an explicit Retry creates a new attempt ID.
- X dismisses the failure persistently. Late results from already-running work must not resurrect its Activity card. X is not a cancellation guarantee for a request already accepted by an external server, and does not delete an existing saved pin.
- Delivery retries are bounded and allowed only while an attempt is active. Do not introduce a scheduler that revisits failed jobs.
- Preserve authentication, rate limiting, ownership checks, transactional pin deduplication, and server-owned interest-profile updates. One genuinely new saved pin should cause one counter/profile update; Retry and source attachment must not inflate these signals.
- Share only server-fetched public-post evidence across users. Keep private share text, notes, home location, user pins and recommendation profiles outside shared content caches.
- Keep the current model initially. Fix reproducible retrieval, input, parsing and matching errors before evaluating a more expensive model.

**Delivery order**

| Phase | Result | Implementation units | Depends on |
|---|---|---|---|
| E0 | A trustworthy baseline and regression fixtures | Benchmark harness and release version stamps | None |
| E1 | Honest, consistent failure messages | Server outcome contract; app/push mapping | E0 |
| E2 | Correct AI answers and preserved evidence | Cache/response validation; metadata/text parsing | E1 |
| E3 | Fewer repeated downloads and provider rejections | Shared extraction; provider admission controls | E1; can run alongside E2 |
| E4 | Better place selection and useful partial saves | Common ranker; partial results and Retry remaining | E2; integrate E3 before release |
| E5 | Controlled processing under heavier traffic | Durable worker admission, shared limits, load tests | E1–E4 |
| E6 | Places found in video text or speech | Small, separately gated media pilot | E0–E5 baseline and budget measurements |

Each implementation unit should be a small PR with its own acceptance tests. E0–E4 are the first release series; E5 is the scaling milestone; E6 is an optional accuracy expansion. Do not wait for media analysis to ship the confirmed fixes.

**E0 — Establish the baseline before changing results**

Build an offline evaluation runner around the production extraction, parsing and ranking functions. Use dependency substitution for Instagram, AI and Google responses so routine tests cost nothing and do not depend on a live post being accessible. Move the isolated review reproductions into committed regression fixtures.

Start with approximately 30–50 labeled examples and expand as real failure categories appear. Include the Kyoto and Taipei examples; same-prefix/different-caption posts; apostrophes and alternate metadata attribute order; login pages and HTTP 429; invalid/truncated AI output; foreign-language venue names; ambiguous chains; same-name venues in different cities; no-venue posts; details outages; mixed successful/unresolved multi-place posts; restaurant-handle-only captions; accounts tagged outside the caption; collaboration accounts; more than five mentions; legitimate handles ending in official; and friends/creators tagged alongside restaurants. Use minimal/synthetic fixtures where possible. Keep actual production records and user identifiers out of git. Label expected Google place IDs only after verifying the venue; do not invent IDs from a caption.

Freeze a separate evaluation subset before tuning prompts or ranking. Track retrieval success, venue recall, wrong-place rate, place-match accuracy, partial outcomes, queue time, processing time, dependency calls and estimated cost per successful new pin. Separate a content download failure from a reasoning failure. A mocked caption test must not be presented as proof the Render server can currently read Instagram.

Stamp new server jobs with engine revision, prompt/schema version, extractor version and enabled feature versions. Add an optional app-build identifier without breaking older requests; any client-created job fields require corresponding validation in Firestore rules.

**Files:** existing `tests/` and `tests/helpers/`; proposed `tests/fixtures/engine/` and `scripts/evaluate-engine.js`; `enrich.js`, `lib/enrichClaim.js`, `Dockerfile`; app dispatch and rules only if adding app-build metadata.

**Done when:** every confirmed review defect has a reproducible baseline case with its expected correct outcome; baseline measurements are saved; repeated offline evaluation is deterministic. Initially report known defects in the benchmark without making the existing test gate permanently red; promote each case to a blocking regression test with its corresponding fix. Record current app, server and Functions test results rather than assuming earlier counts still apply.

**E1 — Preserve the real reason an attempt failed**

Introduce a small shared internal result contract: success with usable data; successfully evaluated empty result; or typed error. A timeout, blocked page, missing configuration, rejected AI call or invalid JSON must never be converted to a successful empty list. Track provider, stage, error code and whether evidence was fully available. Failure classification should use HTTP status and structured error codes first, with message matching only as a fallback.

Keep the existing public job statuses for compatibility. Add an optional server-owned `failure` object with a stable code, stage, provider and optional next-allowed-request time. The time is information for a user-requested retry, not a schedule. Keep bounded diagnostic stage records for support; raw dependency messages should not become user-facing copy.

| Evidence | Suggested Activity and notification message |
|---|---|
| Instagram explicitly rate-limited access | Instagram is limiting requests. Try again later. |
| Post could not be read; cause uncertain | We couldn't read this post. |
| AI service unavailable or response invalid | We couldn't process this post. |
| Text read and evaluated successfully, with no named venue | We couldn't identify a named place in this post. |
| Named venue found, Google unavailable | We found a place name, but couldn't look up its location. |
| Candidate matches disagree or lack enough evidence | Choose which place this post means. |
| Confirmed save/write failure | We found the place, but couldn't save it. |

Do not call a post private/deleted from a generic 403, login page or missing metadata alone. Do not claim the entire video contains no venue if only its caption was evaluated.

Extend the app's failure metadata persistence and mapping while retaining the Retry/X behavior. Unknown codes and old jobs get neutral copy. Update push copy as well as Activity so the two surfaces agree. The server remains authoritative about completed saves, and client dismissal remains respected.

**Files:** `enrich.js`, `enrich/ai.js`, `enrich/places.js`, `enrich/ogMetadata.js`, social readers, `lib/vision.js`, `lib/push.js`; app `enrichmentJobsListener.ts`, `shareQueue.ts`, `queueStore.ts`, `QueueActivityCard.tsx`.

**Done when:** simulated 429, timeout, malformed AI output, genuine empty extraction, ambiguous match and save failure produce distinct correct outcomes. The original two retrieval failures no longer imply that their posts contained no places. Restart and delayed-response tests still prove no automatic retry or card resurrection.

**E2 — Fix cache collisions and stop discarding useful text**

E2-A replaces prefix-based AI keys with a stable hash of the complete normalized input envelope plus the actual prompt/model/output-schema versions. Cover multi-place extraction, single-place fallback and vision, including caption, transcript, hashtags, uploader, mentions, image identity and other inputs that affect the result. Build the envelope and prompt together so future fields cannot influence the model without influencing the key. Outputs incorporating private user-supplied text must be scoped to that user; public-only content results may be shared. Client `/ai/*` requests cannot declare their own input public or populate the trusted shared cache; only an internal server extraction context may do that.

Validate response shape, item types, names, collection bounds and stop reason before caching. Recompute counts from valid entries. Treat truncation, refusal, malformed JSON and dependency errors as errors; an incomplete list must not be labeled complete. Verification returns match, mismatch or unknown; a failed verifier cannot approve a candidate. A verifier may contribute evidence but cannot override a clear geographic contradiction.

Use new cache namespaces so known-bad old answers are no longer read; let old entries expire without a database purge. Cache validated empty results only when the underlying evidence was actually read and evaluated. Keep them short-lived, and let an explicit Retry bypass a prior no-venue answer once within the new attempt. A successful cached metadata read can still be reused.

E2-B replaces the fragile metadata regex with one bounded HTML parser shared by generic and Reel readers. Test single/double quotes, raw apostrophes, attribute order, entities, multiline tags and missing attributes. An HTML login/challenge page is not successful caption extraction.

Represent title, public caption, shared text, subtitles, hashtags and mentions separately. Deduplicate repeated text and remove URL-only noise. Preserve original-language names and address lines. When input exceeds the budget, prioritize venue/address evidence across the text instead of simply cutting off its beginning; record omitted evidence. Do not cache an exhaustive no-venue verdict when meaningful input was omitted. Give the model evidence labels and require support for each proposed venue; post text is data, not an instruction to change the task.

**E2-C — Account tags are evidence, not verified places.** Preserve every syntactically valid caption @mention within a documented bounded input budget; do not discard a business solely because its handle ends in `official`, `eats`, or another personal-account-looking suffix. Capture available same-post structured user tags and collaboration accounts from the returned post metadata, maintaining their origins separately from the uploader. Do not scrape unrelated profile suggestions or silently claim that absent metadata means there were no tags. If a post has more accounts than the prompt budget, prioritize contextual venue/address associations and record incomplete coverage instead of assuming the first five are sufficient.

Supply account handle, available public display name, explicit venue/location context, and origin to the AI. Require supporting evidence before turning a handle into a venue candidate. Tag-only candidates must pass E4 name/geography verification; creator/friend tags, ambiguous handles and missing location should lead to selection or unresolved outcomes, not speculative automatic pins. Include the account evidence in versioned cache keys and preserve private share-text separation. Reuse metadata already obtained from the post. A separate profile lookup is not required for the initial implementation; consider it only as a bounded, measured fallback with provider controls if post evidence remains insufficient.

**E3 integration:** Both extraction routes must return the same optional `taggedAccounts` and `collaborators` fields when supported by the retrieved post. Source adapters must not fabricate these fields when Instagram does not expose them. Test their passage from fixture HTML/reader output through AI and Google matching, and preserve handle-derived source provenance in diagnostics.

**Files:** `enrich/ai.js`, `lib/vision.js`, `lib/cache.js`, `enrich/ogMetadata.js`, `lib/instagramReel.js`, `enrich.js`; proposed shared prompt-envelope and HTML metadata helpers.

**Done when:** handle-only captions reach the model intact; genuine structured tags and collaborators reach the same-post evidence envelope; unrelated creators are not automatically saved as businesses; missing tag data remains unknown; captions with identical introductions produce separate answers; changed hashtags/transcripts invalidate the answer; malformed output is never cached as empty; “Don't miss Tai Sushi in Kyoto” stays intact; useful user-shared text reaches the model; one user's private text cannot affect another user's cached result.

**E3 — Reuse successful extraction and reduce unnecessary provider traffic**

E3-A creates one extraction service used by both `/extract` and `/enrich`. It owns URL validation, canonicalization, routing, metadata parsing and the permitted fallback sequence. Add the specialized Reel route to the shared implementation, preserving TikTok video/photo and Instagram carousel behavior. Validate redirected destinations as well as the initial URL.

Prefer platform/content ID for cache identity. Resolve short-link aliases with bounded redirects and cache their canonical mapping. Remove known tracking parameters such as `stkn` without removing content-defining parameters. Store only validated public extraction results in the shared cache; never cache a block/timeout as a successful blank post. Keep stable thumbnail persistence integrated, and account for expiring media URLs separately from reusable caption text. Do not make thumbnail upload failure fail the place extraction.

Combine concurrent requests for the same public post. Start with an in-process shared promise; before multiple workers, add a bounded Redis lease with an owner token and owner-checked release. Followers wait only within their attempt deadline. Expiry/recovery can occasionally duplicate extraction, so retain transactional pin deduplication rather than claiming exactly-once external fetching. Upstash supports conditional creation and expiry for lease primitives; atomic renewal/release need owner verification. [Upstash SET documentation](https://upstash.com/docs/redis/sdks/ts/commands/string/set).

Fix the in-memory cache to honor each entry's supplied TTL. Separate disposable result caches from coordination state: Redis failure may allow a cached-result miss, but must not silently remove the global provider limit and multiply outbound traffic.

E3-B adds per-provider concurrency and cooldown controls shared by all callers, including legacy `/extract`. Start conservatively and tune using measurements; no fixed Instagram request rate can be promised safe. On an explicit 429, respect a valid `Retry-After` and stop immediately cycling through multiple readers against the same blocked provider. Cooldown is control state, not a cached HTTP 429 response or a failed-job retry schedule. A 429 may include a suggested wait and is not evidence about the video's contents. [HTTP 429 specification](https://www.rfc-editor.org/rfc/rfc6585.html#section-4).

If supplied text is sufficient, the same still-active attempt may continue without another provider request. Otherwise, mark that attempt failed accurately. A user retry during cooldown should explain the wait and make no provider call; expiry only re-enables the user's action. New requests can wait briefly within an explicit deadline, then fail rather than spin indefinitely.

Pin and test the extractor version used by the Docker build, log it at startup, and retain a rollback image. Select the version at implementation time from verified releases; do not assume the version mentioned in the earlier review is still the right target. Remove comments claiming an Instagram page works from any IP.

**Files:** `index.js`, `enrich.js`, `lib/cache.js`, URL utilities, social readers, `lib/ytdlp.js`, `lib/thumbnails.js`, `Dockerfile`; proposed `lib/extractionService.js` and provider-control helper.

**Done when:** simultaneous different jobs for the same public post share extraction on a healthy worker; both routes produce equivalent metadata; aliases/tracking variants reuse it; a 429 prevents an immediate fallback barrage; cooldown expiry starts no failed jobs; Redis outage remains bounded; reader timeouts release resources. Verify shared limits across two worker processes before claiming multi-instance protection.

**E4 — Match the right place and preserve partial success**

E4-A replaces the first-result/fixed-85 path and the separate fallback scoring with one ranker. Compare a bounded candidate set—initially the first five Google results—using supported venue name, address, city/country and original-language aliases. A clear country/city conflict rejects a candidate. Popularity alone must not overcome missing evidence. Retain why each candidate ranked where it did.

Search using the post's destination context. Do not substitute the user's home city or silently trust a server-IP-biased result. Use explicit text location and suitable bias; validate returned geography. Google documents that omitted geographic parameters permit IP bias, while `locationRestriction` applies to categorical queries, so it is not a universal hard boundary for named-business searches. [Google Text Search documentation](https://developers.google.com/maps/documentation/places/web-service/text-search).

Use three decisions: strong match → eligible for automatic save; plausible/ambiguous → user selection; no defensible match → typed failure. Calibrate thresholds and the required gap between candidates against the evaluation set. Do not display the score as a statistical probability. Keep the fallback's positive verifier result useful without forcing every weak candidate above the save threshold.

E4-B retains a strongly matched basic place when optional details fail. Require a real place ID, name and valid coordinates; never manufacture `(0,0)` from absent fields. Save unknown hours/rating/etc. as unknown. Optional details may refresh on demand using a bounded request; this must not rerun a failed link or touch pin/profile counters. Check the applicable storage/attribution policy before expanding retention of Google-derived fields; place IDs are explicitly exempt from the general Places caching restriction. [Google Places policy](https://developers.google.com/maps/documentation/places/web-service/policies).

Before a place ID exists, deduplicate by name plus compatible location evidence; preserve uncertainty instead of collapsing same-name branches in Kyoto and Osaka. After lookup, deduplicate by place ID.

Track each extracted venue as saved, already saved, awaiting selection, or unresolved, with a reason. Add an optional result summary while keeping old job statuses compatible. Show a persistent “Saved 2 of 3 places” card with unresolved names, Retry remaining, Add manually and X. A partial result must not disappear through the existing three-second success-card timer.

**Critical Retry remaining detail:** the current URL/content-ID duplicate shortcut would stop a retry as soon as one place from that post was already saved. Add a parent-job reference and a validated unresolved subset for this explicit action. The server must check that the parent belongs to the caller and the subset was genuinely unresolved, then bypass only the whole-link shortcut. Keep per-place deduplication and existing-pin source attachment. Never accept an arbitrary client-supplied candidate as a verified place. Coordinate request validation, Firestore create rules, job claiming, local receipt persistence and legacy-client compatibility.

**Files:** `enrich/confidence.js`, `enrich/places.js`, `enrich.js`, `lib/placeNameNormalize.js`, job claim/validation; app selection modal, listener, queue persistence/actions, Activity card and Firestore rules.

**Done when:** the Kyoto fixture selects the verified Kyoto venue and rejects Miami; a failed verifier cannot approve a match; ambiguous chains request confirmation; both same-name branches survive; valid basic pins survive details outages; Retry remaining resolves only outstanding venues and never double-counts saved pins, visits, trip signals or interest-profile events.

**E5 — Make execution durable and bounded under heavier traffic**

Use the existing Firestore job records as the durable source of truth initially. Separate accepting an authenticated request from running heavy extraction. `/enrich` acknowledges only after durable admission; a worker claims pending jobs transactionally with an owner/lease and runs them under shared provider limits. Keep the existing Cloud Function compatible as a delivery/nudge path; do not add a second independent queue that can run the same work.

Do not merely move today's “set processing, return 202, run asynchronously” sequence into another file: a crash in that gap must leave discoverable work. Pending accepted jobs may be claimed while still within their deadline. An expired processing attempt becomes failed; do not replay it automatically. Fence terminal updates so an old worker cannot overwrite a newer decision. Stop further provider/AI steps once an attempt is terminal, and preserve any pin already committed before a crash.

Bound outstanding work per user, worker and provider. Add queue-wait and active-work deadlines, network/subprocess timeouts, cancellation and byte limits. Keep user selection outside the extraction execution deadline. Align app grace/stale timers and server sweeper rules so an honest queue wait is not mistaken for failed work. Persist an explicit stage/deadline rather than making the user guess from a spinner.

Initial design targets for load testing, not provider promises: at most 30 seconds waiting for capacity and 120 seconds active processing, with smaller per-stage limits and a separate media budget. Start with one concurrent Instagram fetch per shared outbound identity; establish any increase experimentally. Bound Google/AI concurrency independently. If coordination is unavailable, retain safe cached responses and reject/defer uncached work within the deadline rather than becoming unbounded.

Load-test same-post bursts, unique-post bursts, two worker processes, a provider outage, Redis failure, a killed worker and a duplicate Cloud Function delivery. Use stubbed providers for synthetic traffic; never hammer Instagram to simulate thousands of users. Measure queue age, resource use, dependency calls and cost as well as throughput. Estimate required external fetch rate as peak submitted jobs × uncached fraction, and concurrency as that rate × measured fetch duration. User count alone cannot determine capacity.

Once new jobs have a reliable finalization path, bound the app's historical job subscription with an indexed recent/active query plus direct reconciliation of outstanding local IDs. Handle query removals as a need to reconcile, not discard, a terminal result. Define retention from the product's analytics requirements; do not delete the long-term recommendation/ads signal history just to make Activity faster. Roll this out as a separate PR with its required index.

**Files:** `index.js`, `lib/enrichClaim.js`, `lib/enrichmentSweeper.js`, `functions/index.js`, deployment configuration; proposed worker entry point; app listener/grace timers and `firestore.indexes.json`.

**Done when:** accepted jobs cannot vanish in the response/worker handoff gap; every expired job reaches a final state; two workers obey one provider cap; lost leases cannot authorize more work; no terminal failed job is automatically restarted; reconnecting does not create duplicate pins or lifetime-history read growth.

**E6 — Add video text and audio only where they improve results**

Keep existing carousel coverage: a caption naming one place does not mean later slides contain no additional venues. Immediately bound its image fetch time, bytes and concurrency as part of E3/E5; do not postpone those controls until this pilot.

Run a separate media feature only when available evidence is insufficient and the media is actually accessible. Prefer existing subtitles. Then evaluate a small sampled-frame text pass and, if needed, bounded transcription. Preserve venue names, language and timestamps as evidence for the same E4 ranker. Clearly record when only part of a video was inspected; partial coverage cannot support an exhaustive no-place claim. Media analysis cannot repair an Instagram access block when the media cannot be downloaded.

Proposed pilot limits: at most four sampled frames, two concurrent image downloads, explicit per-image/total byte limits, and one bounded audio/transcription pass. Choose actual media duration/token/cost ceilings from E0 measurements before enabling paid trials. Cache only validated reusable public results under media and model versions. Remove temporary media after the attempt. Keep the feature disabled by default and independently switchable.

**Done when:** held-out voiceover-only and on-screen-text examples improve without additional wrong automatic saves; ordinary caption-rich posts avoid unnecessary media work; time/cost ceilings and failed-job finality hold under timeout and unavailable-media tests.

**Subagent work and review**

Use a coordinator to own contracts, shared fixtures, integration and release gates. After E1 defines the outcome/evidence contracts, separate agents can own E2 cache/AI validation and E3 extraction/provider controls. Assign parsing changes in `enrich.js` to one owner or integrate them sequentially to avoid competing edits. E4 and the client partial-result work can proceed in parallel after agreeing on their summary/retry contract. Use isolated branches/worktrees and small commits.

A separate reviewer should examine actual diffs and rerun relevant tests, particularly private/shared cache separation, geographic contradictions, terminal-state races, partial-result retries and profile/counter idempotence. An agent's completion message is not proof of integration. Confirm its commit, test output and behavior before advancing. This plan does not claim that agents have already executed or reviewed these phases.

**Release gates and rollout**

1. Run server Jest and, for worker changes, the Functions package checks. Run app type checking and the full app suite for shared contract/client changes. Run emulator rules tests with Java 21+ when rules or indexes change. Export the Android bundle and test modified UI in a browser/device; use an actual Android preview for share-intent, cold-start, offline, Retry/X and partial-save checks.
2. Require every targeted regression scenario to pass and zero wrong automatic saves in the fixed adversarial geographic fixtures. Compare held-out wrong-place rate and recall against E0, and investigate regressions. Set numeric live latency/cost/accuracy gates from the measured baseline rather than promising an arbitrary percentage improvement.
3. Deploy additive server contracts before the Android client that consumes them. Use server-owned feature flags, assign versions consistently per job, and start with internal accounts. Expand to a small cohort, then broader usage only after the agreed checks pass. Do not automatically reprocess old failed links as part of rollout.
4. Keep a separate switch for media work and worker admission. Rollback stops admitting new work to the new path, lets compatible active jobs finish or fail within their deadlines, and preserves pin writes, failure finality and X tombstones. A cache namespace change needs no destructive data migration. Never flush the shared Redis instance to invalidate one feature's answers.
5. Release thumbnail Storage configuration/backfill separately from the engine changes unless it is already verified; the local server branch includes that work. Keep onboarding, cold-start receipt capture, Google-note imports, keyboard behavior and existing security protections in regression coverage.

The sequence below was the approved design. The execution table above is the current source of truth for what is implemented and what still needs release validation.
