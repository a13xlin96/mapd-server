# Caption extraction and matching reliability

Approved scope: preserve clear caption evidence; correct address/geography matching; keep uncertain plausible matches selectable; reduce unnecessary media work; validate wrong-branch safety, cost, retries and partial saves. No live provider replay, database migration, credential access or deployment is part of implementation validation.

## Delivery order

1. Reconstructed regression cases for Sushi Urayama, Sun Kwai Heung and Txispa plus wrong-name/street/country/branch controls. Label reconstructed Google responses; do not present the offline suite as measured production accuracy.
2. Constrained caption extraction with strict bounded envelopes, independently validated candidates and an explicit incomplete-result signal. Malformed siblings never authorize trusted identity fields or silently finish a multi-place job. Version only the changed caption operation contract.
3. Typed address and geographic evidence. Distinguish premises from units, country-qualified regions from cities, and unknown formatting from actual contradictions. Every recovery requiring interpretation remains user-confirmed.
4. Preserve extraction errors through media completion and protect valid partial candidates. A completed empty audio pass is not evidence that caption analysis succeeded.
5. Add a recorded, opt-in caption-first audio policy. Old recorded policies retain behavior. Under the new policy only a literal, explicitly marked single-caption venue with a strong verified match skips media; incomplete lists, ambiguity, failed extraction and explicit analysis retry still escalate. No spending limits are enabled.
6. Full regression suite, offline component benchmark, incident replay and an independent adversarial review. Count physical mocked provider operations; avoid speculative dollar savings. Prepare a reviewable branch and release notes. Small live checks remain a separate release validation step.

## Downstream protections

- Preserve authentication, source-fetch protections, user-private cache scope and accounting.
- Keep explicit Retry as the only action that refreshes failed work; no automatic retry loops.
- Preserve selected Google IDs, existing sources and committed pins across failures.
- Never weaken all matching thresholds or substitute AI-invented coordinates.
- Keep caption, source, Google and media cache identities distinct; changed caption interpretation cannot reuse an older failed contract.
- Do not enable video frames or require a paid hosting upgrade.
- App selection receives ordinary candidate pins; avoid an incompatible client contract.

## Acceptance criteria

- The three positive reconstructed cases produce a correct candidate or save according to confidence, rather than an unrelated/no-place failure.
- Wrong street, unit, city and country controls do not auto-save.
- Invalid AI envelopes fail honestly; a valid sibling remains reviewable and incompleteness remains recoverable.
- Audio completion cannot mask a caption parser failure.
- Caption-first positive cases avoid media calls; listicles, weak matches and explicit analysis retries retain escalation.
- No claim that a passing replay proves a live third-party extraction or model result.

## Implementation and offline evidence

The caption model returns one constrained tool result. The server independently
validates each candidate, derives the count, and preserves valid siblings when
another candidate is malformed. Partial results require confirmation and retain
explicit analysis recovery after saving. An ordinary selected-save retry cannot
clear that marker: only an actual complete caption refresh can do so. Completing
audio cannot conceal a caption error. The caption operation has a new contract
identity; unrelated provider caches and receipts retain their identities.

Matching now distinguishes labelled Chinese units/floors from street numbers in
HK/TW/CN/MO. It supports country-qualified administrative regions, with an initial
Basque Country equivalence entry backed by province evidence. This is a bounded
catalog, not a claim to resolve every regional alias. Recovered interpretations
require selection; conflicting street, unit, locality and country evidence still
rejects candidates. A failed address-heavy caption query may make one simpler
name/city/country query, at most two such recovery queries per job. Ranking still
uses the original address and branch constraints.

| Reconstructed case | Baseline matching | Updated matching | Extra mocked Google calls, baseline → updated |
| --- | --- | --- | --- |
| Sushi Urayama Honten | Correct selectable candidate | Correct selectable candidate | 1 → 1 |
| Sun Kwai Heung | Rejected | Correct selectable candidate | 1 → 0 |
| Txispa | Rejected | Correct selectable candidate | 0 → 0 |

Fixtures are short reconstructed inputs from the investigation, not archived API
responses. Sushi's latest failure occurred upstream in caption parsing; the
matching-only comparison does not demonstrate recovery of its live model result.
Separate parser tests cover malformed envelopes, partial candidates and strict
authority boundaries. Pipeline tests exercise all three fixtures through
selection and an idempotent save of the correct identity.

The opt-in `media-v3` audio-only policy waits for matching on a narrowly qualified
single-venue caption. A strong literal name/geography match with exactly one
location marker can avoid audio. Both title and caption are checked for list
cues; partial extraction, uncertain matching and explicit analysis retry retain
escalation. An unmentioned venue elsewhere in the video can still be missed by
this selective policy, so this is a measured cost/coverage tradeoff, not proof
of full video coverage. Existing recorded v1/v2 jobs keep their policy.

Local validation on 2026-10-13: 3,937 passing root tests, 34 intentionally skipped
tests (three environment-specific suites); 35/35 offline regression scenarios;
clean `git diff --check`. The synthetic strong-caption pipeline uses one caption
AI call, one Google search and zero media calls, compared with one media pass
under v2. These counts are not billed cost or live latency measurements. Tool
schema text adds input tokens, partial results use the existing short cache TTL,
and alternate search recovery can increase Google calls within its bound. There
are no new automatic model retries or spending caps.

## Release and rollback

1. Review the branch and require hosted CI, including its isolated provider-free
   tests, emulators and production Docker checks. Deploy reviewed code with the
   current media policy unchanged. Parser and matching corrections then apply;
   no app rebuild is required for the existing selection/recovery contract.
2. Validate the three reported links through explicit diagnostic or user retry
   attempts. Confirm the observed source, candidate identity, selection, save,
   failure/recovery state, request counts and elapsed time. Do not replay old
   failures in the background or clear caches/receipts to manufacture a pass.
3. Only after every writer/worker can read v3, update the existing server-only
   `engineControl/mediaFleet` acknowledgement to
   `minimumMediaPolicyVersion:3`, preserving its other fields. Old binaries must
   be stopped/upgraded first; they cannot enforce a fence they do not implement.
   V3 admission rejects a v2 acknowledgement. Upgraded readers still accept
   previously admitted v2 work under acknowledgement 2 or 3.
4. For a limited authorized cohort, preserve unrelated `ENGINE_ROLLOUT_JSON`
   settings and media bounds; set `mediaPolicy.policyVersion` to `media-v3` and
   `mediaPolicy.analysisMode` to `audio-only`. Preserve provider/model and queue
   settings. Require the existing `mediaRecoveryV1` client capability. Video
   frames remain disabled; Render Free and spending observation stay unchanged.
5. Compare actual-share completion, wrong-match reports, confirmation rate,
   missed-venue recall, latency and physical provider cost before expanding.
   Roll back new enrollment to v2 if coverage regresses; keep v3-capable binaries
   and acknowledgement 3 until all admitted v3 work is drained. Never rewrite
   queued snapshots, completed pins or paid-operation records.

Implementation validation did not access credentials, call live providers,
modify production data/configuration, or deploy a release. Record deployment,
live qualification and rollout separately from these offline results.

## Additional historical replay checks

Expanded coverage on 2026-10-13 adds 35 tests spanning seven venue scenarios and
11 unique Places IDs: 清河鵝肉, Tầm Vị, Bánh Cuốn Hong Kong 189, Rue Miche, Kuma
Omakase, Shang Hao Chicken Rice, and five Tokyo ramen venues. The Google response
fixtures were captured in earlier investigations; captions and model output are
reconstructed, four fixture URLs are synthetic, and Tokyo coordinates retain the
original fixture's documented synthetic values. These are not seven freshly
processed social videos. Both baseline and updated matchers recover these same
11 identities without additional simulated Google requests or missing fixtures.

The fresh-share/retry and v2/v3 matrix also exposed a distinct accounting bug:
an incomplete retry could forget a successfully matched alias after deduplicating
its Places ID, then count the old alias as another unsaved venue. Preserve the
matched clue-to-ID association solely for reconciliation; keep candidates and
saves deduplicated. Only verified aliases participate. Conflicting exact IDs,
unverified names, confirmation requirements and unfinished analysis are retained.
The two failing regressions now finish at 1/1 and 5/5 instead of 1/2 and 5/6.

Controls preserve a truly unresolved prior venue, an outstanding different
Places ID, and the original pin/source on already-partly-saved retries. That last
case also passed before this correction. The historical live Kuma record included
an address conflict; this new accounting regression does not establish that it
caused the older live failure.

All 3,972 root tests pass, with 34 environment-specific skips; the 35/35 existing
offline engine benchmark also passes. The new replay explicitly isolates Redis
and fails on unrecorded lookups even if engine recovery catches their exceptions.
These tests do not measure fresh caption extraction, audio accuracy, live cost,
or Instagram/TikTok access. No new automatic retries or production changes.
An independent adversarial reviewer approved the correction and new replay
coverage with no actionable findings and independently reran all 35 replay tests.
