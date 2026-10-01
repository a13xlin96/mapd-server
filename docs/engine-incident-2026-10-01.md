# Social-link processing incident — October 1, 2026

## Evidence and scope

A read-only review of the authorized account's last seven days found 44 attempts:
39 failed, four completed and one still awaiting selection. The failures included
seven partial saves, eight admission-cap rejections, one queue-expiry timeout,
16 rejected location matches, six empty extractions and one older malformed AI
response. These are attempts, including retries, not 44 distinct posts. The 22
distinct links had 18 failed and four completed latest receipts. This is evidence
for this account, not a measured service-wide failure rate.

All admitted attempts had media analysis off. The existing audio/video code and
separate diagnostic experiments were not an enabled production rollout. The
audio-only failures must not be attributed to Instagram rate limiting or declared
fixed by a location-matching patch. Existing real-video evaluation did not meet
recognition and Free-server timing requirements, so this incident release leaves
media enrollment, provider choice and spending enforcement unchanged.

Four explicitly approved Google Places searches returned the expected public
listings. Their bounded response fields are captured in
`tests/engine/incident-google-responses.json`. The original historical search
response bodies were not retained. The new responses reproduce current matching
decisions; they do not establish the exact historical response or full live AI
extraction accuracy.

## Corrections

* Mixed-script addresses such as a Chinese `號` street-number suffix no longer
  disguise English city components and disable the localized lookup. Taiwan
  administrative 台/臺 spellings are matched without rewriting venue names.
* Romanized Vietnamese names and account handles can receive one bounded
  Vietnamese lookup when the city and country are corroborated. Successful
  primary matches, unrelated names and conflicting cities keep the existing
  no-extra-lookup behavior. The existing six-query per-attempt bound and cache
  reuse remain; recovery requires user confirmation.
* Structured Vietnamese street evidence and business descriptors are handled
  without equating an old district label with a new ward or automatically saving
  an uncertain branch. Exact country, house-number and venue constraints remain.
* A 13-receipt burst previously produced five acceptances and eight immediate
  rejections. New admission allows at most 20 outstanding receipts per account
  and up to 15 minutes of waiting. Actual processing still has its 120-second
  limit and unchanged worker/provider concurrency. Queue expiry remains finite.
  Existing failed jobs are never revived and existing deadlines are not rewritten.
* Worker wake-ups are detached from the initiating HTTP request's deadline and
  abort signal. A completed job can wake the next waiting job even after that
  original request's two-minute context has expired. Each claimed job still gets
  its own bounded execution context.
* Background delivery failure handling must not overwrite an already-admitted
  pending job. The worker and its queue deadline own that state, including when
  the admission response was lost and Firebase redelivers an older event.

The app companion must reconcile a transport-failed receipt before replacing it:
an HTTP response can be lost after admission, and the original job can still be
pending, processing or successfully completed. A longer waiting deadline must
not cause the client to hide the original job or duplicate its work.

## Verification and release boundary

Regression tests replay the captured Maps rows through selection and an
idempotent save using mocked source/AI/storage dependencies. They establish
matching, confirmation and save behavior for those inputs, not end-to-end live
success. Adversarial cases cover contradictory cities/countries, compound house
numbers, route differences, unrelated names and language lookup bounds. Queue
tests exercise the observed burst, waiting past 30 seconds, unchanged concurrency,
expiration, quota release and terminal redelivery.

Local validation: 2,657 server tests passed (34 environment-gated tests skipped),
41 Functions tests passed, 32/32 offline benchmark cases passed, and the
two-process stubbed-provider load check passed. Independent review reproduced
and verified repairs for the request-context leak and background-delivery race,
as well as contradictory-location and localized-lookup budget cases. Hosted CI
must also pass, including real local Firestore transactions and the Docker
runtime checks, before merging. These checks do not certify every live video.

Ship the compatible app companion with the server correction. Existing error
cards require an explicit retry or review after installation. Do not erase
caches, reset paid-operation fences, rewrite historical outcomes, enable a new
provider, or mass-replay user links as part of incident recovery.
