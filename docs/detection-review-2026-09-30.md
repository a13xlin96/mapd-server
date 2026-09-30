# Server detection review contract

Implemented locally on `fix/detection-review-20260930`, based on `61b82c1`
(the reviewed postal follow-up to `07c5b31`). No migration or automatic
consolidation runs. The parent owns mobile integration and publication.

## POST /enrich/review

Requires verified user Bearer authentication. The shared middleware's admin
bypass is explicitly rejected. Request ownership comes exclusively from the
verified UID. The route uses the existing API rate limiter.

Preview (read-only):

```json
{"jobId":"job"}
```

Explicit review (one or more decisions, applied atomically):

```json
{
  "jobId":"job",
  "version":"<preview version>",
  "decisions":[
    {"outcomeId":"<preview item ID>","action":"same_place","savedPlaceId":"<offered placeId>"}
  ]
}
```

`dismiss` is the other action; it accepts no `savedPlaceId`. `same_place`
requires an eligible server-owned suggestion; if `savedPlaceId` is omitted,
that suggestion supplies the identity. Neither action creates a pin, attaches
a source, changes saved-place counters, starts work, or invokes a provider.
An omitted clue is untouched. No name/ranked-ID coincidence auto-resolves a clue.

Every successful preview/mutation returns:

```json
{
  "version":"<opaque SHA-256 fingerprint>",
  "revision":0,
  "savedCount":1,
  "unresolvedCount":1,
  "completed":false,
  "analysisRecovery":null,
  "items":[{
    "outcomeId":"<opaque clue ID>",
    "name":"Cafe",
    "city":"Brooklyn",
    "address":"",
    "savedPlace":{"placeId":"place","pinId":"pin","name":"Cafe","address":"10 Main St","city":"New York"}
  }]
}
```

`analysisRecovery` is the existing valid recovery contract projected to its
four public fields (`version`, `status`, `reason`, `canRetry`), or `null`.
The stored recovery and media retry operations are left unchanged even when
all place clues are dismissed and the job becomes complete.

`savedCount` counts distinct committed identities, joining receipts sharing
either a place ID or pin ID. `unresolvedCount` equals `items.length`. All
unresolved outcomes appear, including those ineligible for `same_place`.
Names/cities are capped at 200 characters, addresses at 500, with control and
format characters removed and whitespace collapsed. IDs are bounded to 200
ASCII letters/digits/underscores/hyphens; outcome IDs and versions are generated
by the server. Requests reject extra fields. At most 160 outcomes/decisions
are supported, and distinct committed identities plus unresolved clues must
not exceed 100 (the mobile receipt limit). Empty/malformed unresolved names
also fail with 409 `review_unavailable`, rather than returning an unusable
or partial preview. Raw outcomes, rankings, failures and provider data are
never returned.

A suggestion requires the same complete normalized name in the clue, committed
outcome and current pin; branch qualifiers remain significant. The clue must
have no bound/confirmed place or pin identity, and no save/attachment failure.
It must have exactly one ranked candidate, matching a committed saved/existing
outcome, with one unambiguous committed pin reference. That pin must still
exist with the authenticated owner and matching place ID. Conflicting geography
is displayed for a user's decision; the suggestion is not proof of identity.
Leading articles are significant: `The Chef’s Table at Brooklyn Fare` does not
match `Chef’s Table at Brooklyn Fare`. The latter clue can still be explicitly
dismissed; this patch does not broaden name equivalence.

## Storage, concurrency and retries

Only owner schema-2 terminal `failed` / `partial_save` jobs with committed and
unresolved outcomes are initially eligible. `processing`, `needs_selection`,
legacy jobs and unrelated failures are rejected. A previously reviewed complete
job can be previewed and an unchanged repeated request acknowledged.

The transaction reads the job and all referenced committed pins before its
single job update. Versions include all outcomes and job status, owner/schema,
recovery and execution identity, plus raw pin identity/name/address/geography
and creation time. Truncated display strings never determine freshness.
A missing, changed or recreated pin invalidates an earlier version.

Decisions preserve the original outcome's evidence and set `status: dismissed`
with review metadata. `same_place` records the chosen identity inside that
metadata, never as an `existing` outcome. Progress counts distinct committed
identities plus remaining unresolved clues. While clues remain, status stays
`failed` with `partial_save` and `saved < total`. With no unresolved clues,
status becomes `complete`, and `failure`/`error` become null. Each mutation
sets `updatedAt` using a server timestamp for other-device discovery; that
mutable timestamp is excluded from the version fingerprint.

Every decision increments a per-job integer revision, starting from zero for
unreviewed jobs. Previews and identical request redeliveries do not increment
it. Mobile receipts persist this revision so a delayed older snapshot cannot
restore a resolved clue after a restart. The opaque version includes revision
and still enforces full compare-and-set validation on the server.

The job holds the last request hash and resulting fingerprint. Identical
concurrent/delivery retries succeed without another write only while the result
is unchanged. A stale request cannot operate on new work at the same array
position. Reload preview on conflicts. This receipt is bounded to the latest
review; an older delivery after another review can return 409.

Retry context retains review metadata. Reviewed dismissals suppress only the
same complete name/city/country/address and bound identities (case-sensitive
IDs). They never suppress another branch or geography solely by a ranked ID.
Normal retry, explicit analysis retry, deferred outcomes and selected-save
retry all preserve the dismissal. Legacy selection dismissals retain their
previous behavior.

## Errors

- 400: `invalid_review` (invalid request), `invalid_decision` (not an eligible
  current clue/suggestion).
- 403: `access_blocked` (owner mismatch, missing job, admin bypass).
- 409: `review_conflict` (stale version), `review_unavailable` (ineligible job).
- 503: `review_unavailable` (storage unavailable/unconfigured).

Authentication middleware retains its existing 401 behavior for absent/invalid
Bearer credentials. Error bodies contain stable codes, never exception text.

## Offline validation

`tests/detectionReview.test.js` covers transaction boundaries, atomic rollback,
read-only preview, all eligibility exclusions, full names/branches, distinct
counts, field bounds, forged IDs, cross-user access, stale job/pin state,
concurrent taps, replacement work, recovery and exact-clue retention.
`tests/detectionReview.http.test.js` mounts the production route registration
with real auth middleware and fake storage. `tests/engine.http.test.js` verifies
registration in the shipped app. `tests/detectionReview.retry.test.js` exercises
the enrichment pipeline across repeated normal/analysis/selected retries with
provider calls mocked. Existing selection and retry regression suites also run.

Validation includes focused contract/retry/HTTP tests, the configured root
suite, and offline engine fixtures. Provider responses are mocked in tests;
no production job replay or migration is part of this release.
