# Mapd: next improvements implementation plan

September 14, 2026 · Status: implementation prepared on `feat/engine-next-improvements`; integration verification and independent review are recorded in `docs/engine-next-improvements-execution-2026-09-14.md`. Production rollout remains gated.

## Outcome and scope

Make saved-place counts and recommendation signals trustworthy, keep processing costs from growing with library size, measure real extraction accuracy, and improve reliability as usage grows. Then expand language support and make saved content and unfinished selections usable after a restart.

This covers the seven follow-up improvements from the latest review. It builds on server `3e9b194` and app `791e103`. The preceding engine changes are implemented locally; that does not establish what is deployed. The [previous implementation plan](/Users/alexlin/workspace/mapd-server/docs/engine-implementation-plan-2026-09-13.md) and [adversarial review](/Users/alexlin/workspace/mapd-server/docs/engine-adversarial-review-2026-09-14.md) remain the record of that work.

The current engine already has authenticated admission, shared provider limits, typed failures, caption/account-tag evidence, conservative matching, partial saves, and explicit Retry/X handling. These are foundations to preserve, not features to rebuild.

**Fixed requirements:**

- Failed processing attempts stay stopped. Restarting, reconnecting, or clearing a provider cooldown never starts extraction again. Only the user’s Retry creates another attempt.
- X persists its dismissal. Existing saves remain saved; late results cannot restore a dismissed card.
- Preserve private recommendation and advertising signals. Repairing counts does not delete behavioral history or recreate the removed debug log.
- Never expose another account’s pins, source links, visit state, or cached data.
- Retain older-client compatibility during migrations. Ship server contracts, rules, and indexes before dependent app changes.
- Do not add video-frame OCR, new audio transcription, or a more expensive model in this scope. Those require a separate measured pilot.

## Delivery order

| Order | Workstream | User benefit | Dependencies |
|---|---|---|---|
| 1 | F1: save accounting and interest profiles | Accurate counts; repeat requests cannot inflate recommendation history | Minimal F4 checks before release |
| 2 | F2: direct content lookup | Sharing does not scan the user’s entire library | F1 mutation/reconciliation contract |
| 3 | F3: accuracy, delay, and cost measurement | Know which changes actually improve results | Instrumentation can start alongside F1 |
| Foundation | F4: automated checks and staged release controls | Catch regressions before everyone receives an update | Starts immediately; gates all releases |
| 4 | F5: queue efficiency and fairness | Lower background cost and predictable service under load | F3 measurements; F4 rollout controls |
| 5 | F6: language and subtitle coverage | Find venues named in other languages and available subtitles | F3 evaluation; F4 flags |
| 6 | F7: offline browsing and selection recovery | Browse saved places offline; finish choosing places intentionally | F1 counts, F4 contracts; independent of F6 |

Each workstream ships in small changes with its own tests. F4 is an early release prerequisite, not a reason to delay the accounting fix until every other improvement is finished.

## F1 — Count real saves once and protect interest profiles

### Verified problem

The authenticated interest-profile endpoint accepts category/city/country and increments a count without checking that a pin was saved. Calling the shipped route twice against a local fake database produced two profile increments with zero pins. Separately, creating a pin through the server transaction left the legacy user counter unchanged in a local reproduction.

These are confirmed accounting defects, but they do **not** establish the cause of the earlier “876 stayed 876” display: the current Profile screen renders the length of the loaded pins array. Preserve that distinction when testing.

### Implementation

1. **Define separate measurements.** `currentPins` means currently owned saved-pin documents, regardless of list memberships. A source attachment and a retry are not new pins. Record `pin_created`, `pin_deleted`, `source_added`, and visit actions as separate event types. Keep current visited-place counts separate from visit-event history. Adding one pin to three lists counts as one pin; saving three distinct places from one post counts as three. A delete and later new save may be a new save event, with recommendation weighting preventing repeated actions from dominating interests.
2. **Use committed database changes as the common accounting boundary.** Add a Firestore pin-write function so server enrichment, manual search, imports, featured-list clones, legacy selection, and single/bulk deletion all pass through the same mechanism. A successful HTTP request alone never establishes a save. Derive owner and pin identity from the persisted document; distinguish server-verified place metadata from user-entered categories or notes. A real document proves an in-app action, not a real-world visit or the truth of arbitrary text.
3. **Separate current state from event history.** Maintain a server-only per-pin contribution record. In a transaction, reread the current pin and its prior contribution and apply only the difference to current totals. A delayed create notification after deletion must not restore the count. Separately, store a minimal immutable event receipt and apply history/profile effects atomically, keyed by committed mutation identity and event type. Event timestamps, not arrival order, determine the latest-save fields. Pin recreation uses a new document generation identity. Retries of the function must have no extra effect: Firebase explicitly permits duplicate and out-of-order trigger delivery. [Firebase trigger semantics](https://firebase.google.com/docs/functions/firestore-events).
4. **Introduce new canonical documents.** Use `users/{uid}/stats/current`, `users/{uid}/interestProfile/v2`, and server-only contribution/event collections. Only the owner can read their intended summary; clients cannot write counters, receipts, or index internals. Do not add trigger increments to `users/{uid}.totalPins`: older app versions already modify that field and would double-count. Treat that root field and the old profile as legacy during migration.
5. **Retire the unverified writer safely.** After the new event capture is proven, make the old category-only `/interest-profile/pin-saved` request an authenticated compatibility acknowledgement with no counter mutation. New app code removes this call. If a reconciliation hint is retained, require a pin ID, verify ownership, and only schedule the idempotent projection; ignore submitted profile attributes. Remove direct `recordPinSaved` increments. Move save-derived trip/recommendation effects to durable consumers with per-event receipts, replacing fire-and-forget calls. Never run both old and new writers into the same projection.
6. **Keep immediate UI feedback and durable totals distinct.** The app may show its loaded owned-pin count immediately. Use the canonical total when the inventory is incomplete; never add both values together or show a server total of zero while migration is unfinished. Trace the Profile screen after a genuinely new save, duplicate-place source attachment, and failed save. Move pin subscription ownership to the authenticated root in F7.

### Migration and recovery

- Deploy capture in shadow mode into new collections with a server-controlled cutover timestamp. Mark each account’s projection `building` until validated. Existing consumers continue reading the old projection during comparison.
- Backfill existing pins in resumable pages through the same transactional contribution reconciler. The migration establishes current inventory and explicitly labeled baseline interests; it must not pretend all historical pins were newly saved today. Use server document timestamps rather than client-supplied creation dates to distinguish baseline records from post-cutover events.
- Preserve the previous profile as legacy history with unknown accuracy. Do not add its count to the new verified count. Publish `historyCoverageStart` so recommendations and reporting know where reliable event history begins.
- Live triggers and backfill share idempotency rules. Finish with a comparison against actual pin counts after pending projection work settles. Repeat reconciliation for mismatches; do not overwrite totals while writes are racing.
- Switch account-by-account only after parity, then switch consumers to v2 and retire legacy writers. Later retirement of root-counter writes requires a compatible app rollout and matching rules; it is not required to trust the new canonical stats.
- Account deletion must tombstone the account before cleanup; late events cannot recreate its profile or indexes. Recover failed accounting deliveries through a bounded repair queue and alerting. This repair updates derived data only and never reprocesses a failed social link.

**Files:** [interest-profile route](/Users/alexlin/workspace/mapd-server/lib/interestProfile.js), [save pipeline](/Users/alexlin/workspace/mapd-server/enrich.js), [functions entry point](/Users/alexlin/workspace/mapd-server/functions/index.js), [pin store](/Users/alexlin/workspace/mapd/src/stores/pinsStore.ts), [list store](/Users/alexlin/workspace/mapd/src/stores/listsStore.ts), [Profile screen](/Users/alexlin/workspace/mapd/src/screens/ProfileScreen.tsx), [rules](/Users/alexlin/workspace/mapd/firestore.rules). Add dedicated projection, event-consumer, migration, and test modules rather than expanding the large stores further.

**Release tests:** forged/repeated requests produce zero invented saves; every real save path produces one event; duplicate delivery and concurrent saves do not inflate totals; source attachment does not increment pins; bulk/list deletion converges correctly; rapid create/delete/recreate and backfill races work; old and new clients coexist; account deletion stays deleted; a consumer crash recovers without missing or duplicating a recommendation signal. Owner/non-owner rule tests cover every new collection.

**Done when:** current counts match stored inventory after projection catch-up, all post-cutover saves have one verified receipt, and recommendation consumers use the new projection without discarding historical data.

## F2 — Replace full-library duplicate scans

**Problem:** `findPinByContentId` fetches all pins owned by the user and inspects primary URLs and source arrays. The cost grows with every saved place, even when checking one link.

**Implementation:**

1. Create a server-only user/content index using canonical provider IDs and a versioned normalization scheme. Store one membership per content/pin relationship, not an unbounded array in a single document. A post can legitimately reference several saved pins.
2. Add/update/remove memberships whenever the pin’s primary URL or sources change. Reuse F1’s latest-state reconciliation for legacy client writes. New server saves update relevant memberships in the pin transaction where transaction limits allow; any remaining repair is durable.
3. Look up only this user’s matching content memberships, page through large matches, and verify referenced pins still exist, belong to that user, and still reference the content. Repair stale rows asynchronously. An index hit is not proof every venue in a multi-place post has been resolved.
4. Keep validated parent outcomes for Retry remaining and per-place transactional deduplication. A temporarily missing index row must cause ordinary bounded processing, not an incorrect “already saved” result. A duplicate lookup is an optimization, not the uniqueness guarantee for pin creation.
5. Backfill with checkpoints and account readiness markers, then shadow-compare results. For unmigrated accounts, permit the existing scan temporarily behind a measured compatibility flag. Remove that fallback for migrated accounts; an outage must not silently reinstate a full scan on every request.

**Files:** [lookup/save pipeline](/Users/alexlin/workspace/mapd-server/enrich.js), [content-ID parsing](/Users/alexlin/workspace/mapd-server/enrich/urlUtils.js), the new F1 projection modules, [source mutations](/Users/alexlin/workspace/mapd/src/stores/pinsStore.ts), and [rules/index configuration](/Users/alexlin/workspace/mapd/firestore.indexes.json).

**Tests and gate:** primary URL plus attached sources; equivalent URL variants; same post in different accounts; multiple places per post; source removal; last-source removal; pin deletion; index lag; concurrent shares; partial retries; interrupted/resumed backfill. For a single matching pin, measured lookup reads should stay approximately constant across libraries of 10, 1,000, and 10,000 unrelated pins. No cross-user results and no dropped unresolved venues are acceptable.

**Rollback:** turn off indexed reads while retaining index writes and readiness checkpoints. The old scan is a temporary rollback path, not the target architecture.

## F3 — Measure actual accuracy, latency, and cost

**Problem:** the 32 synthetic cases protect known behavior; they do not establish live Instagram accessibility or real-world place accuracy. The previously named holdout was inspected while developing and is no longer blind.

**Implementation:**

- Assemble an initial 150 manually labeled posts: 100 development cases and 50 sealed evaluation cases, expanding as traffic reveals gaps. Include both reported failures in regression cases, not the blind set. Cover multiple languages, tags, branches, missing captions, multiple places, and posts with no venue. Verify expected venue/branch identities independently. Store real post evidence in restricted storage, not public source control; keep consented/minimal or synthetic fixtures in git.
- Run two evaluations: fixed captured evidence to compare extraction/matching fairly, and a small authorized live retrieval sample to measure source accessibility. Track these separately so a 429 is not reported as a reasoning error. Do not create load by repeatedly scraping live Instagram.
- Instrument each stage with job/attempt ID, server-selected feature version, platform, evidence coverage, duration, outcome, cache hit, provider calls, and actual token usage where available. Calculate estimated cost using a dated rate table; label unknown costs and validate estimates against provider usage. Do not invent precision from incomplete usage data.
- Report correct auto-saves divided by all auto-saves; wrong-place/branch rate; expected-venue recall including missed venues; human-confirmation rate; blocked-source rate; partial outcomes; p50/p95 queue and processing delay; cost per attempted link and per correctly saved new place. Show denominators, sample size, and uncertainty, broken down by platform/language.
- Add private operational reporting for projection lag/mismatches, failed event delivery, lookup reads, queue age, provider rejection/cooldown, cache savings, and spending trends. Keep operational diagnostics separate from long-term behavioral history; avoid raw private captions, notes, URLs, tokens, or user IDs in unrestricted logs or metric labels.

**Files:** [pipeline](/Users/alexlin/workspace/mapd-server/enrich.js), [provider runtime](/Users/alexlin/workspace/mapd-server/lib/providerRuntime.js), existing evaluation fixtures/runner, and [client analytics](/Users/alexlin/workspace/mapd/src/services/analyticsService.ts). Add a versioned metrics contract and a small internal report first; a new observability vendor is unnecessary for this phase.

**Gate:** collect a baseline before changing matching behavior. Every rollout report compares against that baseline and discloses sample limits. Block release for confirmed new wrong-place regressions; latency or cost growth over 10% triggers investigation and an explicit documented tradeoff before expansion. The 50-case set is an initial check, not evidence of population-wide accuracy. Once inspected for tuning, replace the blind set.

## F4 — Automate checks and control exposure

**Implementation:**

1. Add CI workflows in both repos. Server: clean locked installs, root and separate Functions tests, regression evaluation, and Docker build/smoke checks. App: typecheck, unit/component tests, Java-21 Firestore-rules emulator tests, and Android bundle export. Make missing tests a failure; remove reliance on `--passWithNoTests` in required checks. Use stubbed external services and no production credentials in ordinary PR runs.
2. Record the app/server revisions, contract versions, rules/index revision, and built artifacts in a release manifest. Test the new server with both supported old and new app contracts. A JavaScript export does not replace an installable Android preview or native-device testing.
3. Add server-controlled flags for the new projection reader, content-index reader, queue policy, language routing, and selection contract. Derive cohorts from verified accounts; clients cannot select a privileged rollout group. Save the chosen feature versions on admitted jobs so queued work is not silently switched mid-attempt. Client flags default to compatible behavior if unavailable.

   Implementation clarification: projection/content/language remain account cohort flags. Queue scheduling is a fleet-level policy, recorded per admitted job and checked transactionally against a private fleet control; a mixed legacy/fair fleet cannot guarantee fairness. Switching requires draining and stopping the old workers first. The already-supported v2 selection protocol is recorded as a capability for new jobs, with old recorded contracts retained; F7 client recovery rolls out through the app build. Neither a flag rollback nor a protocol downgrade may restore automatic selection modals or weaken confirmation idempotency.
4. Keep emergency controls distinct: stop new admission when necessary; disable optional new behavior for future jobs; preserve already committed saves and terminal state. Accounting capture and compatibility routes must remain safe during rollback. Never reset a failed job to pending as a rollback technique.

**Release ladder:** internal accounts → a stable 5% cohort → 25% → all accounts. Each expansion needs at least 24 hours plus sufficient reviewed outcomes for the affected feature; time alone is not a pass. Any cross-account data exposure, duplicate writes, false completion, or confirmed new wrong-place behavior stops expansion immediately. Keep optional language behavior off until F3 has evaluation results.

**Review gate:** another reviewer checks migrations, permissions, concurrency, and backward compatibility before merging each workstream. A separate subagent review is preferred when its runtime works; otherwise use a human/independent reviewer and record the limitation. The earlier independent-agent review could not run because its tool lacked a configured provider. Do not treat a direct self-review as an independent pass.

**Files:** new workflow files under each repository’s `.github/workflows/`; existing package/test configuration; server admission/configuration modules; [client feature flags](/Users/alexlin/workspace/mapd/src/stores/featureFlagsStore.ts). Extend only flags relevant to this rollout; leave membership-migration controls independent.

## F5 — Reduce queue reads and prevent starvation

**Problem:** the worker polls every second, retrieves 50 queued documents, then sorts that subset locally. Older work outside that subset can be overlooked, and idle or capacity-constrained processes still query repeatedly.

**Implementation:**

- Order the Firestore query globally by the server-owned queue deadline and a deterministic tie-breaker before applying its limit. Current fixed queue-wait deadlines provide arrival ordering; retain a separate admission timestamp if deadlines later vary. Add the required composite index and backfill missing ordering fields before enabling the query, since ordering excludes documents without the field.
- Replace fixed polling with a coalesced admission nudge plus bounded polling recovery: immediate scan when capacity opens, short waits when eligible work exists, and jittered idle backoff initially capped at five seconds. Avoid extraction-discovery scans while local capacity is full. Keep separate bounded expiry/reconciliation sweeps so full workers cannot strand expired pending work.
- Preserve per-user admission limits, transactional claims, provider caps, and owner/deadline checks. Across the globally ordered candidates, limit one account’s simultaneous active work so one heavy sharer cannot occupy every slot. Page past temporarily ineligible accounts with a bounded scan budget and continue from a cursor; one blocked head entry cannot hide the rest of the queue.
- Release capacity on crashes/expiry using existing lease ownership rules. A delivery arriving for a completed/failed job is acknowledged without extraction. Provider cooldown expiry makes new eligible jobs possible; it never restarts failed ones.
- Keep Firestore as the queue for this phase. Revisit a managed queue only if measurements show scanning cost or dispatch latency remains material. Cloud Tasks can deliver duplicates and does not promise FIFO; adopting it would still require ownership, idempotency, fairness, and terminal-state checks. [Cloud Tasks limitations](https://docs.cloud.google.com/tasks/docs/common-pitfalls).

**Files:** [worker](/Users/alexlin/workspace/mapd-server/lib/enrichmentWorker.js), [admission](/Users/alexlin/workspace/mapd-server/lib/enrichAdmission.js), [sweeper](/Users/alexlin/workspace/mapd-server/lib/enrichmentSweeper.js), provider runtime, and [indexes](/Users/alexlin/workspace/mapd/firestore.indexes.json).

**Tests and gate:** more than 50 pending jobs with shuffled IDs; several accounts; two worker processes; missed nudges; duplicate deliveries; full capacity; Redis outage; killed workers; expired deadlines; provider 429. Use stubbed providers for load. Demonstrate no eligible account is indefinitely starved, no cap is exceeded, no terminal attempt runs again, and idle query frequency drops by at least 80% with recovery dispatch within the five-second poll bound under the test conditions. These are queue targets, not promises that Instagram will accept requests.

## F6 — Broaden available language evidence

**Problem:** subtitle extraction currently requests English tracks only. The main pipeline routes Instagram/TikTok through social extraction, while YouTube takes the generic metadata path.

**Implementation:**

1. Centralize exact-host/provider classification so supported YouTube videos can use the same bounded extraction/subtitle contract. Preserve URL safety, deadlines, shared leases, and public/private cache scope. Test canonical, short, and mobile URLs; reject lookalike hosts.
2. Read available track metadata and select at most two useful tracks: original/source-language evidence first, then an available translation when it adds information. Mark automatic captions and translated tracks. Do not fetch every language or synthesize a transcript when none is available. Keep existing character, file, time, and token limits.
3. Preserve native venue names, diacritics, aliases, and source provenance through extraction and matching. Normalize Unicode deliberately; use transliteration or translated aliases as supporting evidence, not a substitute for city/branch confirmation. Do not infer the venue’s country from the user’s home location or device language.
4. Evaluate a dedicated multilingual slice including Chinese, Japanese, Korean, Spanish, mixed-language captions, and restaurant handles. Retain confirmation for ambiguous tags and branches. Missing subtitles should fall back to the available evidence without turning a blocked fetch into “no place exists.”

**Files:** [subtitle extractor](/Users/alexlin/workspace/mapd-server/lib/ytdlp.js), [routing/pipeline](/Users/alexlin/workspace/mapd-server/enrich.js), [name normalization](/Users/alexlin/workspace/mapd-server/lib/placeNameNormalize.js), extraction/cache contracts, and multilingual evaluation fixtures.

**Gate:** previously available captions still work; native names survive end-to-end; absent/broken tracks do not erase good caption evidence; foreign-city and wrong-branch tests pass; measured multilingual recall improves without a confirmed new false auto-save. Report incremental calls, latency, and cost. New OCR/transcription remains off and out of this implementation.

## F7 — Offline browsing and intentional selection recovery

**Problem:** native Firestore uses memory caching, and the Map screen owns the global pin subscription. An unfinished place selection can also reopen a modal automatically after restart.

### Offline browsing

- Move the owned-pin subscription to the authenticated root, alongside other account subscriptions. Map/list screens select data without globally clearing it on unmount. Cancel old-account listeners and pending cache writes with an account/session generation guard.
- Add a versioned SQLite read cache for owned pins, owned list metadata, and memberships needed to browse them. Hydrate the signed-in account before waiting for the network; show that content is saved locally and when it last refreshed. Reconcile confirmed deletions and snapshot completeness so a partial or failed fetch cannot wipe good cached data. This is a browsing cache, not a new offline mutation queue.
- Keep shared/featured content session-only initially. Do not present cached foreign pins as proof of current authorization. They become available again after an online permission check. Clear account-specific data on logout/deletion and never hydrate one account into another. A revoked remote permission cannot be learned while fully offline; this policy avoids promising immediate remote revocation of downloaded shared content.
- Keep tokens outside this cache. Configure local backup behavior deliberately, and avoid copying raw provider payloads or unrestricted analytics into it. Cache failures must not break the separately durable share receipts or onboarding state. Persist owned metadata independently from image caching; offline pictures are best effort if image bytes have been evicted.

### Unfinished selection

- Persist an `awaiting_selection` Activity state with job ID, saved/remaining summary, schema version, and dismissal state. Write it before presenting any UI. Show “Finish choosing places”; open selection only when the user taps it, including after cold start. Do not automatically interrupt launch with a modal.
- Reconcile by exact job ID. An offline tap explains that confirming choices requires connection; it does not start extraction. Selection submission uses the existing authenticated, idempotent server contract, and repeated taps/restarts cannot duplicate pins or source attachments.
- X dismisses the item across restart. A stale server event cannot resurrect it. If candidate data is no longer available, explain that state and offer an explicit retry/manual-add action; never silently re-extract. Preserve the existing compatibility path for older selection jobs.

**Files:** [root navigator](/Users/alexlin/workspace/mapd/src/navigation/RootNavigator.tsx), [map subscription hook](/Users/alexlin/workspace/mapd/src/hooks/useMapPinsForView.ts), [pin store](/Users/alexlin/workspace/mapd/src/stores/pinsStore.ts), [job listener](/Users/alexlin/workspace/mapd/src/services/enrichmentJobsListener.ts), [SQLite queue](/Users/alexlin/workspace/mapd/src/utils/shareQueue.ts), [Activity card](/Users/alexlin/workspace/mapd/src/components/QueueActivityCard.tsx), and new isolated offline-cache modules/tests.

**Tests and gate:** signed-in cold start in airplane mode; switching tabs without clearing pins; logout/account switch during hydration; deleted pin stays deleted after sync; cache migration/corruption; offline selection tap; kill during selection submission; repeated confirmation; X plus delayed updates; legacy selection jobs. Validate on an Android preview on a physical device. Owned lists/pins remain browsable, failed jobs stay stopped, and unfinished choices never auto-open.

## Work packages and review assignments

Use subagents for independent bounded tasks when the runtime is available; keep one integration owner per shared file. Do not have multiple agents edit `enrich.js`, rules, or the same store simultaneously.

| Package | Implementer scope | Review emphasis |
|---|---|---|
| A | F1 schema, projection/event handlers, regression tests | Duplicate/out-of-order events, trust boundaries, deletion |
| B | F1 migration and legacy-client transition, after A’s contract | Backfill races, missing history, double writers |
| C | F2 index and migration, after A | Multi-place posts, removals, cross-account access |
| D | F3 metrics/evaluation; can run beside A | Blind-set integrity, false-positive definitions, private data |
| E | F4 CI/flags; starts beside A | Clean installs, old contracts, rollback semantics |
| F | F5 queue, after instrumentation | More than 50 jobs, multi-process fairness, no reruns |
| G | F6 language evidence | Ambiguous geography, limits, honest missing evidence |
| H | F7 client persistence/recovery | Account isolation, stale callbacks, Android lifecycle |

For each package: reproduce the defect → implement → run relevant tests → adversarial review by a different reviewer → resolve findings → integrate → run the cross-repo checks appropriate to the changed contract. A reviewer should try to forge events, duplicate delivery, crash during commits, switch accounts during async work, and make a partial result look complete. Record reviewer identity and any unavailable test environment honestly.

## Release sequence and completion evidence

1. Confirm actual deployed revisions, runtime configuration, existing indexes, and supported app versions. The local branches also contain thumbnail work; account for its Storage setup separately rather than assuming it is already live.
2. Land F4’s required checks and F1’s tests/contract. Deploy additive private rules/indexes and shadow event capture. Verify Functions deployment configuration includes the new functions; the current script names only the existing enrichment trigger.
3. Run a read-only migration report, then a resumable additive F1/F2 backfill with recorded checkpoints. Do not purge existing analytics or overwrite legacy history. Confirm parity before enabling new readers per account.
4. Release the compatible server, then an Android preview. Test genuinely new saves, duplicate source attachment, manual/import/clone paths, counts, partial Retry, X, restart, and collaborator privacy. Compare displayed count, actual owned-pin inventory, canonical stats, and event receipts separately.
5. Use F3 reports and F4 cohort gates for F5/F6. Roll out F7 through a new Android preview with the offline/selection device matrix. An Android bundle passing alone is insufficient.
6. Preserve schema compatibility and event capture during rollback; disable new readers/optional processing rather than deleting documents or replaying failed attempts. Keep a migration report, test results, reviewer findings, release manifest, and comparison report with each release.

**First implementation slice:** reproduce the interest-profile forgery and count mismatch in committed tests, define the new server-owned accounting contract, and implement its idempotent projection in shadow mode. This produces a reviewable fix before any historical data or app behavior changes.
