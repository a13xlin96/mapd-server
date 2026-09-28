# Processing recovery fixes and media pilot — September 27, 2026

## Objective and authorization
The user approved a plan followed by execution of the four recommended fixes: robust AI-answer handling, failure-aware manual retries, deeper evidence for unverified names, and accurate activity-card wording. Include real-media verification and an account-only pilot when prerequisites pass. Do not expand to other users, automatically retry failed jobs, resurface dismissed jobs, alter monetary controls, or process unrelated historical links. Cost controls remain observation-only. Implementation, publication, and pilot state must be reported separately.

## Baseline and confirmed problems
Working repositories contain previously authorized uncommitted changes. Preserve those exactly. Implement in isolated copies of the source verified identical to deployed server 6c8eba1 and app snapshot 1b4b0f0; compare file hashes before integrating changes back.

Production evidence in /private/tmp/mapd-engine-diagnosis-20260927 confirms:
- DdwKi3iJlBq: source and AI requests succeeded, but JSON parsing failed before Google matching. The exact malformed response was not retained; do not invent its contents.
- Ddu8iwqyxgP: generic Michelin pho was interpreted as a venue. An explicit retry reused that unresolved phrase and cached Google results without new analysis.
- Both attempts recorded media disabled. Code deployment and API credits did not enable the account pilot.
- The two older multi-place cards have 3/6 matched coordinates and Place IDs; they await selection and should be distinguished from unresolved names.

## P1 — Reliable AI response contract and diagnostics
Owner: parser worker. Scope: server AI request/parser helpers, focused tests, directly related shared-error diagnostics.
- Make the extraction answer contract explicit; use supported structured output only if compatible with the current model and client. Otherwise enforce bounded deterministic parsing plus existing strict schema validation, with no additional paid model call.
- Permit only an unambiguous, complete JSON value surrounded by harmless framing; reject truncation, multiple competing objects, refusals, malformed envelopes, oversized responses, and provider-returned trusted fields.
- Preserve all-or-nothing list validation; never silently drop malformed venues or invent missing names/geography.
- Record private bounded rejection reasons (format/envelope/schema/stop reason); avoid raw model output/captions in logs or client-readable records. Preserve public stable error codes and privacy through shared-operation reconstruction.
- Version changed AI identity/prompt behavior so old bad results are not reused as fresh corrected extraction.
- Verify parse/schema matrix, no extra provider dispatch, shared failure propagation, and existing API contracts.

## P2 — Retry according to the failure
Owner: parent. Scope: retryContext, enrichment integration, source/Places cache behavior where necessary, matching evidence policy, focused tests.
- Explicit retry of unverified identity must refresh/re-examine evidence and permit selective media fallback. Retry of an already confirmed save must retain the selected Place ID and save it without silently choosing another branch.
- Retain saved/existing/dismissed outcomes; no resurrection, double-save, or extra analysis for confirmed-save-only recovery.
- Avoid treating descriptive food/award phrases as verified names. Require identity evidence and use weak matches as recovery triggers. Do not use a broad blacklist that rejects real businesses or non-English names.
- Preserve validated evidence/caches for successful operations; selectively refresh only failed evidence and stale negative matching results. Bound all retry work to an explicit new user attempt. Do not implement automatic paid repair loops.
- Verify initial no-match, partial saves, selected save failures, contradictory identities, old jobs, explicit retries, and media unavailable behavior.

## P3 — Accurate cards
Owner: app worker. Scope: queue activity presentation and minimal typed propagation of verified candidate counts if needed, plus component/service tests.
- Matched candidates with verified Place IDs and finite coordinates should read N places ready to choose.
- Unresolved names and mixed results must not be counted as ready. Show the corresponding unresolved/confirmation state without making all cases look like extraction failures.
- Old queued jobs remain readable; tap actions, persisted queue state, Retry and X semantics stay compatible.
- Verify 3/6 matched candidates, unverified and mixed results, partial saves, legacy records, and actual rendered button actions. Run app typecheck and component/integration tests; attempt available browser/simulator UI validation.

## P4 — Media activation readiness and measured pilot
Owner: parent, with read-only prerequisite audit if useful.
- Confirm current deployed worker/rules support version-2 recorded media policy; current app advertises mediaRecoveryV1; required provider key/model access and FFmpeg paths work; dispatch stop and TTL/resource settings are coherent.
- Test accessible, authorized video evidence including spoken-name and visible-sign paths using existing evaluation tooling. Record actual venue correctness, processing time, provider calls and costs/unknown costs. Source access failure is distinct from failed recognition; obey source 429/access blocks.
- Verify no-media, successful-media, and partial-media states; successful pins survive optional media failures. New media-derived locations require user confirmation during pilot.
- Once real checks support the pilot, record fleet compatibility, set internal-account media rollout only, keep public percentage zero, preserve unrelated flags and observe-only costs. No historical jobs rerun automatically. An explicit new retry must get a fresh recorded configuration.
- If external access or missing reference media prevents valid end-to-end verification, finish all independent fixes and report the precise outstanding requirement. Never call a disabled or unverified pilot enabled.

## P5 — Independent review, integration, delivery
- Independent adversarial review focuses on parser ambiguity/injection, retry authority and selected identity, saved/dismissed data preservation, extra provider spending, media compatibility, and misleading UI states.
- Resolve important findings, run appropriate full server/app tests and typecheck, and rules tests if rules change. Keep opt-in paid tests isolated and record test limitations.
- Integrate only this change set into original working directories after baseline hash checks; preserve unrelated work. Keep plan, evidence, and execution report reviewable.
- Publication/deployment, if performed for the authorized pilot, follows verified clean source and exact release provenance. No mobile build unless needed for compatibility or separately requested; app-copy changes require a new app release to reach installed devices.

## Definition of done
Code and targeted regressions pass, independent review findings resolved, and every operational step is recorded as completed or concretely blocked. The report explicitly distinguishes local fixes, deployed fixes, and account pilot activation. Existing bad jobs remain unchanged until an explicit user retry or authorized targeted evaluation; the app never starts an endless loop.
