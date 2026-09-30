# Follow-up to the location-matching release

## Observed retry results

Read-only inspection of the two reported links confirmed both latest attempts
ran release `07c5b3136e4c8db979b5fe57e52ba66d9cf8c5dd`. No jobs were replayed,
pins edited, caches cleared, or paid provider calls initiated for this diagnosis.

**Kuma Omakase:** the new city-alias handling succeeds, but matching still records
`street_number_conflict`. Its public Google Maps listing shows
`44 Đặng Thị Nhu, Bến Thành, Hồ Chí Minh 700000, Vietnam`. The matcher
reproduces a false street-number conflict when the six-digit postal code is
present and the search response lacks a structured postal-code component.
The historical raw Google search response was not retained; the public listing
and synthetic reproductions identify a concrete parser defect, not an exact
reconstruction of that request.

**Orova post:** two committed outcomes refer to Orova Cafe & Wine Bar and
Chef's Table at Brooklyn Fare. Two unresolved image-derived hypotheses repeat
those names and point to the same individual ranked Google IDs, but carry
different geography. The latest progress therefore reads two saved out of
four hypotheses. Matching now recovers saved places, while accounting still
treats unresolved duplicate hypotheses as additional places.

## Implemented: bounded postal-code correction

Six-digit postal codes can be removed only from the final non-country address
segment, after a complete vetted Vietnamese locality name and with Vietnam
country evidence. Existing locality aliases are reused. Route segments,
different street numbers, compound street numbers, and other countries remain
subject to the existing conflict rules. The same normalization is used for
candidate geography, candidate street evidence, and source-address evidence.
An explicit route matching the apparent locality or any known six-digit
street number disables this heuristic. That guard applies to source hints too,
including differing numbers and missing or malformed route components.
Recovered uncertain candidates still require confirmation.

This changes no providers, flags, budgets, storage schemas, or mobile code.
It adds no API calls. It is a local follow-up patch until separately published.

## Duplicate-hypothesis correction: implementation boundary

Do not delete an unresolved hypothesis merely because it has the same name or
ranked Google ID as a saved outcome. Rejected rankings do not establish identity,
and `addressConflict:false` on an empty address does not validate the city.
Chef's Table's disputed Brooklyn clue could be derived from its name, but the
current image contract lacks field-level provenance to establish that.

The next change should distinguish committed places from unresolved clues:

1. Group a possible duplicate for review only when it is from the same logical
   share, has the same complete normalized name, and its sole ranked ID matches
   a committed outcome. Preserve branch qualifiers and original evidence.
2. Automatically consolidate only when canonical branch/address/country and
   source geography corroborate the relationship. Preserve conflicting or
   unverified geography as pending review, not another failed save.
3. Offer an explicit choice: the clue refers to the saved place, it refers to
   another location, or dismiss this clue. Linking a clue must not write another
   pin, attach another source, or increase counts.
4. Persist the decision through retry and dismissal. Old clients must continue
   to see unfinished work rather than falsely receiving completion. Do not
   introduce an unhandled status or nest pending work where existing retry and
   completion code would lose it.
5. Verify interrupted saves, failed attachments, distinct branches, conflicting
   countries/street numbers, repeated retries, and dismissals. Summary accounting
   must never report a partial save with saved equal to total.

The duplicate-hypothesis UI/accounting change is not included in this postal
patch. Both saved places remain intact; no historical outcomes were rewritten.

## Validation

Focused fixtures use the public address with synthetic coordinates/ID and
complete, incomplete, and absent address components. Negative controls keep
real house-number, route-number, country, and compound-number conflicts.
The configured root suite (`jest --roots tests --runInBand`, the scope used by
`npm test`) passed 2,378 tests across 130 suites, with 34 tests / three suites
skipped. A broader direct Jest invocation also discovered the separate
`functions/` project and failed to load that suite because its
`firebase-functions/v2/firestore` dependency is not installed in this worktree.
The functions project was not changed or validated by this patch.

Independent adversarial review approved the scoped fix after two rounds of
route/house-number edge-case corrections. It verified 249 focused tests,
18 conflict probes, and 43 malformed-component probes. The offline benchmark
passed all 32 scenarios. These results do not validate the deferred duplicate
hypothesis change or guarantee another live attempt will succeed.
