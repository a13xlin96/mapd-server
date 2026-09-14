# Engine implementation: adversarial review

September 14, 2026. Reviewed the actual working implementation against server base `1a21ce2` and app base `03ad6a7`. The primary scope was account-tag evidence, place matching, private caches, authenticated admission, partial saves, failure finality and bounded execution. This was a direct adversarial review with negative tests, not an independent-agent approval. The requested agent runtime could register an agent but could not execute it because no LLM provider was configured.

## Findings corrected before delivery

| Risk found | Correction and evidence |
|---|---|
| **P1: explicit country mismatch could still pass an exact-name match.** | Country constraints now participate in rejection alongside city/address evidence. A Japan-versus-Miami regression fails the old implementation and passes the correction. Unknown geography retains the named candidate but requires confirmation. |
| **P1: an AI-labeled caption candidate could bypass tag confirmation.** | The ranker checks original text with handles removed. Tag-derived names remain subject to confirmation. The same confirmation gate applies before attaching a new source to an existing pin. Names or geography invented by the model also require confirmation. AI schemas reject attempts to supply trusted `confirmedPlaceId`, `requiresSelection`, or internal `vision` provenance. |
| **P1: a crash after saving one selection could lose the unfinished subset on Retry.** | The server persists the selected place IDs. Retry checks existing owned pins, excludes unchosen candidates, retains saved outcomes, and constrains resumed selections to their confirmed place IDs. Cross-user parents and invented candidate IDs are rejected. |
| **P1: generic metadata requests could reach internal addresses or follow unsafe redirects.** | HTTPS-only fetches reject private, local, mapped and translated IP targets; reject mixed public/private DNS answers; pin validated DNS to the connection; revalidate redirects; and bound response size/time. Tests also caught and corrected an IPv4/IPv6 blocklist interaction that initially rejected legitimate public IPv4 addresses. |
| **P2: obsolete `engineQueued` flags could clog the worker scan.** | Terminal flags are cleared transactionally, with admission quota released. The original terminal job is not executed again. |
| **P2: malformed structured tag arrays could discard a readable caption.** | Structural guards retain caption evidence, and unknown or partial tag metadata is reported as such. Known login boilerplate is rejected before it can become an apparent no-place AI result. |
| **P2: short-link and TikTok reads bypassed some bounds.** | Short-link resolution uses bounded validated HEAD requests and shared provider controls; simultaneous aliases share resolution. TikTok photo HTML uses the bounded streaming reader and preserves 429/Retry-After. Internal yt-dlp retries are disabled within the already bounded subprocess. |
| **P2: a stopped source append could be swallowed as an ordinary duplicate.** | Revoked execution/deadline errors propagate. Tests call the actual pin/source transaction functions and verify that no pin or source is written after the job becomes terminal. |
| **P2: legacy region inference still bypassed shared AI controls.** | The route now uses the shared provider gate, explicit time/token/input limits, validated responses and a typed error on provider failure. |

The first four targeted attack cases were reproduced failing before correction; all four then passed. Additional tag/metadata tests reproduced their failures before correction. Full-suite verification caught the public IPv4 regression and a non-Latin candidate regression during hardening; both were corrected. The final version preserves uncertain named candidates for selection rather than treating the rank score as a probability of correctness.

## Boundary checks

- The actual Express routes are imported without starting workers or binding the production port. Authentication tests cover extraction, AI, admission and selection. A forged user ID cannot create a job; an AI caller cannot choose a public cache scope.
- AI cache identity includes the complete normalized input, version and scope. Unscoped calls do not persist. Invalid/truncated/refused results are not cached as valid empties; valid empties have a short TTL. Explicit Retry bypasses them.
- Only trusted, matching-post tags are extracted from structured data; unrelated posts, suggested users and the uploader are not promoted to venue tags. Tag-only matches and unknown geographic context need confirmation.
- Admission survives the response/worker handoff gap. Duplicate delivery and two worker claims do not restart a processing/terminal job. Deadline and worker-owner checks fence actual pin writes and source appends.
- Redis read/admission outages start no uncached provider work. Lost leases cannot return stale results or delete the new owner's lease. The two-process simulator recorded ten requests with peak provider concurrency one, about two seconds total. This validates the control mechanism, not Instagram throughput or production capacity.
- Partial selection, retry parent ownership, forged candidates, persistent Retry/X state, and client attempts to overwrite pending/processing/failed job statuses have regression coverage. Existing counter/profile deduplication tests remain green; this is not a new exactly-once telemetry architecture.
- Safe-fetch tests cover private/mapped IPs, DNS rebinding prevention, mixed DNS answers, relative redirects, redirect loops, HEAD method preservation, social 429s and disallowed redirector URLs.

## Final verification

| Check | Result |
|---|---|
| Server Jest | **656 tests, 55 suites passed** |
| Cloud Functions package | **13 tests passed**; also included in the server suite |
| App Jest | **710 tests, 56 suites passed** |
| TypeScript | **No errors** |
| Firestore emulator rules | **178 tests, 6 suites passed** |
| Original synthetic regression corpus | **32/32**, versus saved baseline **12/32** |
| Two-process coordination | **10 stub requests, peak concurrency 1** through a simulated Redis HTTP service and the real client |
| Android JavaScript export | **Succeeded**, final bundle about 9.94 MB |
| Modified Activity card | Real component checked at 320px browser width: partial progress, Retry failure/success, Add manually and X |
| Source checks | Changed/new JavaScript syntax and whitespace checks passed |

The benchmark contains synthetic component cases, not live posts or measured end-to-end accuracy. Its historical “holdout” label does not mean it remained blind during implementation. Do not describe 32/32 as a production success rate.

## Release limits

No server, rules or indexes have been deployed by this implementation. No new APK was produced, and no physical Android share-intent/cold-start test was run. The browser check covers the Activity component and its callbacks, not the native share pipeline.

Docker was unavailable, so the container image still needs a build/smoke test. The exact pinned yt-dlp and curl_cffi versions were installed and checked in a separate supported Python runtime. Production Redis behavior and real Instagram access were not load-tested; Instagram can continue returning 429 or blocking the server despite these controls.

The local repository's prescribed `@Codex-flow/cli` scanner is unavailable: the registry check returned E404 and rejected its uppercase package name. No scanner success is claimed. Negative tests and source review above supply the review evidence instead.

No separate live latency/cost/accuracy calibration or per-account rollout flag was added. Start with an internal test deployment and preview build, verify required indexes and Redis configuration, then measure before expanding. Additional video-frame/audio extraction was intentionally not implemented or enabled; it remains an optional pilot after live calibration. This review does not certify every existing route or database rule outside the modified engine scope.
