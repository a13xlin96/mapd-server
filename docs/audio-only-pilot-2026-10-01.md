# Audio-only pilot

## Problem and implementation

Live share jobs have media analysis disabled. Prior combined diagnostics missed
spoken venue names and exhausted frame-scan time on Render Free. Audio should
be qualified independently of visual analysis; a decoder fix or passing mocks
is not evidence of real recognition accuracy.

The trusted recorded media policy now accepts
`{policyVersion:'media-v2',analysisMode:'audio-only'}`. It retains the chosen
`gpt-4o-mini-transcribe-2025-12-15` provider adapter and existing bounds. Audio
acquisition, decode, transcription, grounding/fusion and place matching remain
in the existing pipeline. The collector performs zero frame-selection or
video-vision calls. Visual coverage is `unavailable/disabled_by_policy`, not an
incomplete operation that needs retry.

Default `media-v1` policies have exactly their previous shape and still mean
audio plus frames when enrolled. Already-admitted snapshots keep their mode
through configuration changes in either direction. No old job is upgraded.
New policies must be completely serialized; missing fields are rejected on
execution rather than filled with today's defaults.

Whole-result manifests include the complete policy and therefore separate the
two modes. Identical physical ASR/fusion requests retain their original shared
identities, cached results and spend fences. A mode change must not become an
excuse to repeat a paid operation or reset an uncertain outcome.

## Downstream behavior

- Source failures, timeouts and partial transcripts retain the existing honest
  coverage/recovery contract. A grounded caption save survives optional audio
  failure. Successful audio-only work does not ask users to retry missing frames.
- Spoken candidates still require selection and Google location confirmation;
  a plausible transcript is not an automatically verified saved place.
- Parent cancellation still blocks late evidence, caching and save commits.
- Provider remains interchangeable at the adapter boundary; this change does
  not silently switch models. Private notes and reference answer keys never
  become transcription prompts.
- Media allowance remains 60 seconds, with matching/save time reserved under
  the 120-second active job limit. Audio-only still downloads a bounded media
  asset; removing frame analysis does not solve inaccessible source media.
- Render Free, queue policy, spending observation, accounting and app retry
  behavior stay unchanged. This feature requires the app's existing
  `mediaRecoveryV1` capability; it does not require new UI/native code.

## Verification and rollout order

1. Run the full mocked server suite and offline engine cases. The real-decoder
   smoke now also exercises the audio-only coordinator with generated media,
   non-silent PCM, no visual calls and explicit fake providers. Hosted Docker
   CI must run it with the shipped Linux binaries, without networking.
2. Review changes independently for authority, retries, cancellation, cache
   identity, disclosure and compatibility. Local decoding of retained source
   bytes is useful but is not a Free-tier latency or accuracy measurement.
3. Deploy the reviewed reader/code with enrollment still off. Keep old workers
   stopped/upgraded before admitting the new policy. Do not roll binaries back
   to a reader that rejects an already-admitted `media-v2` policy.
4. Run newly authorized one-use **audio-only** diagnostics on known source URLs.
   Use the existing operator helper with `--analysis-mode audio-only` only at
   ticket creation. No expected names, user notes, cache bypass, retry-generation
   advance, old ticket reuse, job creation or pin writes. Confirm the report's
   mode, audio coverage, actual provider/cache metrics, zero visual calls, names,
   cost and timing. Compare with held-out reference names after processing. A
   partial/miss result is evidence to investigate, not permission to loop calls.
5. Once diagnostic results are adequate, enable only the owner's actual share
   path. `engineControl/mediaFleet` must first contain
   `{schemaVersion:1,minimumReaderVersion:2,writersEnabled:true,minimumMediaPolicyVersion:2}`.
   The additional policy fence rejects accidental early audio-only admission
   under the old reader acknowledgement. Preserve unrelated control fields.
   In `ENGINE_ROLLOUT_JSON`, preserve unrelated flags, set `snapshotVersion:2`,
   the exact authorized internal UID, `rolloutPercent:0`, `flags.mediaEvidence:true`,
   and the v2 audio-only `mediaPolicy` above. Keep `ENGINE_QUEUE_POLICY` unchanged.
   Confirm a new explicit attempt records the expected snapshot, follows normal
   caption/Google/save timing, and offers the correct selection. Diagnostics
   alone skip caption AI, Google matching and persistence and cannot prove this.
6. Expand beyond the owner only after actual-share success, cost and timing have
   been reviewed. Failed historic shares never restart automatically; the user
   explicitly retries. Disable new media enrollment to stop expansion; do not
   mutate queued snapshots, receipts, tickets or paid-operation fences. Existing
   admitted policies remain readable. The separate live media-execution stop
   control is available for emergency dispatch shutdown.

No production configuration or data is changed by these source changes or by
running the tests. Record actual deployment and diagnostic evidence separately.
