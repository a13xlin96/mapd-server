# Text AI response contract (P1 recovery, 2026-09-27)

The confirmed DdwKi3iJlBq attempt reached AI successfully and then failed JSON parsing. Its exact response was not retained. This change covers deterministic framing/contract failures; it does not claim to reproduce that lost response or recover the existing failed job.

## Request and parsing

The existing `claude-haiku-4-5-20251001` Messages request and installed SDK remain unchanged. No structured-output parameter, SDK upgrade, provider call, automatic retry, or paid repair is introduced. SDK retries remain zero. There is no new second request on a format or schema failure.

The prompt requests exactly one complete JSON object, explicit required keys and bounded fields. Extraction specifically explains that `$5 Michelin pho` plus `#saigon` supplies cuisine/award/price/region context rather than a named venue, unless other evidence identifies a restaurant. It does not blacklist food or award words in real business names. Actual model adherence and venue correctness remain unmeasured by mocked tests.

`lib/aiResponse.js` requires `end_turn` and 1–8 text content blocks. Refusal and non-text blocks fail closed. Joined text is bounded to 65,536 UTF-8 bytes, including framing and inserted block separators. Supported framing consists of whitespace/BOM, a single plain or JSON Markdown fence (including the former inline form), and an optional literal case-insensitive prefix: `Here is the JSON:`, `Here is the result:`, `JSON:`, or `Result:`. Arbitrary prose and trailing commentary are rejected. Multiple blocks must together contain exactly one complete JSON value.

JSON is parsed without correction, substring extraction, brace completion, or candidate selection. Multiple objects, truncation, malformed/unpaired fences and invalid JSON fail. A scan over the complete parsed JSON rejects duplicate keys (including equivalent Unicode-escaped keys) and nesting deeper than 16. Quoted braces, escaped quotes and backticks inside strings remain data.

Extraction requires `places`, permits only the top-level keys `places` and `count`, and validates the entire array of at most 40 places before normalization. The provider's redundant count is ignored whether absent, incorrect or nonnumeric (including null, boolean, string, array or object); the returned count is always the validated array length. Ignoring this metadata never selects, truncates or repairs venue information. Ordinary JSON framing, duplicate-key, byte and depth limits still apply to the complete response, including discarded count data. Shared/cache results remain strict: they must contain a numeric count equal to the array length and are never repaired on read.

Each place requires a nonblank name; existing optional geography/source/handle fields remain compatible, including null or omission. Unknown top-level and venue fields are rejected, including IDs, coordinates and verification flags. A single invalid venue rejects the entire answer even when count needs normalization. Verification and region helpers likewise reject unknown keys; region alignment cannot discard extra or duplicate entries to manufacture completeness. Output API shapes and stable public error codes are unchanged.

## Private diagnostics and cache identity

Parser errors have no raw SyntaxError cause or model response attached. Non-enumerable `aiResponseReason` is limited to these literal values:

- `envelope`, `stop_max_tokens`, `stop_refusal`, `stop_other`, `refusal`
- `response_too_large`, `format_empty`, `format_framing`, `format_json`, `format_duplicate_key`, `format_depth`
- `schema_places`, `schema_verification`, `schema_regions`

Shared coordination copies only an allowlisted reason into the existing server-owned `engineSharedAiOperations` failure record and reconstructs it as non-enumerable for followers. It never stores model text or caption in these diagnostics. Public `failureOf`, nullable verifier failures, JSON serialization and error spreads omit the reason; retry-generation behavior is unchanged. Old records without a reason remain readable. In local fallback mode the reason exists on the error but is not durably recorded.

Only text AI identity changes: the per-kind prompt suffix becomes `:2`, options identity becomes `bounded-ai-2`, and the compatibility AI cache key includes response version `2`. `engineVersion.js` is unchanged. Existing source, Google Places and media cache identities are unaffected. No old jobs are rerun or mutated.

## Validation

Focused offline tests mock all provider calls and use in-memory Firestore. They exercise actual extraction/verification/region requests, standard and framed responses, schema and malicious cases, bounded diagnostics, single dispatch, durable failure reconstruction, no automatic repair and unchanged projections. Count-normalization regressions cover empty and nonempty arrays, absent/wrong/nonnumeric metadata, rejection of malformed venues and unrelated fields, canonical persisted results, unchanged projections and TTLs, duplicate count keys, and rejection of noncanonical shared results without another dispatch.

Commands:

```sh
npm test -- --runInBand --runTestsByPath tests/aiResponse.contract.test.js tests/engine.ai.test.js tests/sharedAiOperation.test.js tests/sharedAiOperation.correctness.test.js tests/engine.regressions.test.js tests/aiRetry.http.test.js
```

Count-normalization follow-up: 242 tests passed across these six suites, with syntax and scoped whitespace checks passing. This run used no network or listening socket; `aiRetry.http.test.js` invokes mocked route handlers directly. The separate socket-based `engine.http.test.js` suite previously passed 11 tests during P1 review and was not rerun for this no-network follow-up. Full integration validation remains with the parent.

Limitations: this remains a strict parser over unconstrained output, not a provider-guaranteed schema. Outputs with genuine syntax damage, truncation or unfamiliar prose still return the stable failure for an explicit user retry. No live model evaluation, emulator run, production dispatch, commit or deployment is part of P1. Retry/media/matching changes belong to the parent implementation.
