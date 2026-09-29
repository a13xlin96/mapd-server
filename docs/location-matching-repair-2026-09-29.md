# Location matching repair

## Problem and intended behavior

A recent read-only audit found 10 failures among 11 shares: six detected names but failed location matching, and four found no usable name. The original Google response bodies were unavailable, so synthetic fixtures reproduce the decision defects without claiming to reconstruct every historical response.

The repair addresses the matching stage. Gemini/video extraction remains a separate experiment. No media feature flags, provider credentials, spending controls, failed jobs, or user pins are changed by this patch.

## Implementation

1. **Separate missing address information from contradiction.** Address assessment reports `not_provided`, `match`, `unknown`, or `conflict`. A missing ward/neighborhood component can produce a confirmation candidate even when structured Google fields are incomplete. A differing country or street number remains a rejection. Country- or outer-region-anchored addresses also reject uncorroborated comparable city/state positions, including a wrong city before a matching state. Unverified streets require confirmation even if venue name and city match.
2. **Add country-scoped locality equivalence.** Google's Vietnam country evidence permits vetted Ho Chi Minh City/HCMC/Saigon and Hanoi spellings, plus explicit Vietnamese/English ward-label equivalents. Venue names are not translated or aliased. Locality aliases cannot erase differences between route names. Recovered locality evidence from either extracted fields or captions requires confirmation unless a previously confirmed place ID is supplied; confirmed IDs still cannot bypass actual conflicts.
3. **Downgrade the caption `in …` heuristic to tentative evidence.** An unmatched phrase such as “in 3 days” no longer rejects an exact-name candidate. It lowers ranking and requires confirmation. An explicitly extracted contradictory city still rejects it. Candidates matching a supported caption locality rank ahead of tentative mismatches.
4. **Allow bounded Vietnamese Google-language recovery.** Only failed initial matching with Vietnamese evidence and a response-language mismatch can request a Vietnamese response. The existing six-lookups-per-link bound, query/language memoization, cancellation checks, and mandatory confirmation remain. Successful primary matches add no request. Vietnamese cache entries are isolated from default and other languages.
5. **Close the existing-pin confirmation bypass.** OG fallback no longer treats a saved pin as proof that a newly shared source belongs to it. Uncertain matches wait for confirmation before a source or pin mutation. Confirmed high-confidence duplicates stay immediate. Repeated confirmation remains idempotent.
6. **Make failure diagnostics useful.** Ranking records add city-hint provenance, tentative-city agreement, locality alias recovery, address state, and bounded reason codes. Engine-generated `no_verified_match` outcomes and final failures identify the `matching` stage. Provider errors retain their original stage/provider/retry metadata.

## Downstream effects and limits

- Some former failures become confirmation choices. Some formerly automatic saves with unverified street evidence also require confirmation. This is deliberate protection against wrong branches or unrelated sources.
- A tentative caption phrase alone does not prove a conflicting city. The candidate can be shown for review, but it cannot authorize automatic saving.
- Locality aliases are narrow and country-scoped. They are not a global address normalizer; comparison of anchored geographic positions remains conservative and can still require future refinement.
- Existing NYC, SF, and LA alias behavior is preserved. New Vietnamese locality recovery requires confirmation. The country spelling “Việt Nam” is valid in explicit country/address fields, but cuisine prose such as “món Việt Nam” cannot independently establish a venue's geography.
- Newly eligible Vietnamese recovery may add a Google request only after an unsuccessful primary match and a language mismatch. Existing bounds and caching apply. No extra AI verification call is introduced merely for a tentative caption phrase.
- Google source/cache data is re-ranked using the repaired logic; no shared-cache purge or paid-operation reset is required.
- Failed and dismissed jobs never restart automatically. After deployment, users explicitly choose Retry for a failed share.
- This is a server-only patch. It uses the existing selection flow and needs no app schema migration or mobile rebuild.
- This fixes reproducible decision paths, not a measured guarantee that all six historical matching failures will succeed. The four extraction failures need separate work.

## Verification

Use Node 22 and the existing server dependencies. No live-provider tests or live-user writes are part of validation.

```sh
node node_modules/jest/bin/jest.js --roots tests --runInBand
node scripts/evaluate-engine.js --strict
```

Focused regressions cover partial identical addresses, missing neighborhoods, Vietnamese aliases, wrong-country/street-number/confirmed-ID rejection, caption prose, missing and ambiguous geography, language cache isolation, cancellation/lookup budgets, existing-pin confirmation, dismissal, repeat selection, and diagnostic serialization.

The synthetic component benchmark now asserts candidate eligibility **and** the confirmation requirement. A score alone is not permission to save. In particular, its wrong-city caption fixture must remain confirmation-only, and its non-Latin fixture without independent location evidence must also require confirmation.

Final integrated verification: 2,359 tests passed across 129 suites; 34 emulator-dependent tests across three suites were skipped because no Firestore emulator was running. All 32 synthetic component scenarios passed. Independent adversarial review approved the final changes with no remaining actionable findings and separately verified 271 focused tests across seven suites. The review checked confirmation bypasses, contradictory geography, malformed provider fields, language detection, country/cuisine ambiguity, route-name preservation, and compatibility with existing NYC/SF/LA behavior. These results do not measure live extraction accuracy.

## Release sequence

Review and publish the server patch separately from the Gemini pilot. After deployment, explicitly retry a small selection of the recent matching failures. Verify that recovered candidates show the correct address, sources attach only after confirmation, and remaining failures record their actual matching reason. Do not enable Gemini, restart all failed jobs, or clear caches as part of this release.
