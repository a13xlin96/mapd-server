# Audio-only live qualification findings

The reviewed audio-only server implementation (PR 27, merge 0f870e3) was deployed to Render Free with normal-share enrollment disabled. Two new one-use diagnostics performed no pin/job writes and no Google matching. Neither historical tickets nor failed paid-operation generations were reset.

## Measured production results

- Pho reel DdwKi3iJlBq: 37.7 seconds total, four successful ASR requests, one successful fusion request, zero frame/vision calls. The model returned Pho Gia Trinh, Pho Ga Nguyet and Pho Tin. Against the user's reference names, two are misheard and one expected name is absent. The retained transcript itself contains these spellings; extraction did not introduce them. Reference names were not sent as prompts. This is not an accuracy pass.
- Crab reel DauhHNHRXIw: 27.3 seconds total, two successful ASR requests, zero frame/vision calls. Fusion returned a response rejected as `format_framing`; the raw response was not retained, so its precise wrapper/refusal/content cannot be reconstructed. No places were returned. The saved ASR text discusses crab dishes and Ho Chi Minh but contains no restaurant name; the independent reference identifies Quán Thuý 94 from an on-screen sign. Audio-only cannot establish that name from this transcript. This is not an end-to-end pass.
- Retained **local renditions** have trailing differences of 0.125 ms and 0.6895 ms between decoded audio and container duration. The old facade treated those tiny differences as incomplete. The production download had a different byte size and its container duration was not reported, so these local results do **not** establish the cause of the live warning.
- After PR 28 deployed, a third diagnostic reused both crab transcripts (zero new ASR calls), made one structured fusion request, and returned `partial` in 18.5 seconds with `responseValidation: envelope`. Audio was still `partial/audio_unread`. Thus PR 28 did not qualify the live integration.
- Cost telemetry contains only partial estimates (ASR: $0.0030575 and $0.00101625 under the configured price table). Fusion and source calls lack configured rates. These figures are not total per-link costs or reconciled bills.

## Coverage correction

Only a sole trailing gap below one millisecond, with contiguous successful coverage starting at zero, actual audio chunks, and no failures/cancellation, is considered complete at millisecond precision. Its reason is `submillisecond_tail`. Actual evidence intervals and timestamps remain unchanged; no samples or words are invented or padded. Initial/internal gaps, tails of one millisecond or more, missing audio, and provider failures remain incomplete. Physical ASR requests, shared identities, caches and retry authority are unchanged.

Sanitized live diagnostic reports preserve that reason. Offline replay retains its separately identified unobserved tail and accepts only the corresponding final one-millisecond window at its integer timestamp precision; other incomplete observations cannot claim complete.

The real-decoder smoke now uses the real transcription facade with stub provider responses. It previously fabricated complete coverage, hiding this mismatch. Decoder/provider-stub checks demonstrate interval handling, not recognition accuracy.

## Response-format prevention

For the new audio-only mode, the fusion request declares one structured data output instead of relying on the model to wrap JSON in ordinary prose. This is prevention of the observed format-error class, not proof of what the lost response contained. The same model and literal-evidence/grounding checks remain; no second request or automatic repair loop is introduced. The prior combined mode keeps its existing request contract.

Anthropic documents forced single-tool output for supported models: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools. The pinned SDK supports tools/tool_choice; this declaration is used to receive structured data and does not execute any external tool.

## Remaining qualification

The current official Anthropic SDK declares `caller` on `ToolUseBlock` and optional nullable `toolset_name`. The initial parser admitted only type/id/name/input, so it rejects documented direct-caller responses. A compatibility patch accepts `caller: {type: 'direct'}` and a null toolset name while preserving single-tool/name/input/grounding validation. This is a confirmed contract mismatch, not proof of the lost response's exact fields. It keeps the same request, paid-operation identity and retry fences. Source: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts.

Future failures distinguish block-count, metadata and caller validation using fixed reason codes, without retaining response text. Numeric timing observations preserve container/stream duration, prepared intervals and actual gaps; none are added to reusable evidence manifests or paid-operation inputs.

## Reproduced progressive AAC timing mismatch

A new source-only acquisition selected the same 8,119,747-byte crab rendition as the live diagnostic and reproduced the exact decoded endpoint. Its declared container/audio duration is 32,806.939 ms, video duration is 32,700 ms and clean continuous decoded audio ends at 32,718.3125 ms. The last AAC packet declares 135.057 ms despite adjacent packets declaring 46.440 ms and actual decoded samples ending after the nominal frame. No AI or Google calls were made for this measurement.

For audio-only mode, a private decoder provenance record can now certify `available_audio_complete`: an unclipped embedded track must decode cleanly from zero, reach the explicit video end, and every prepared chunk must be successfully transcribed. Source digest, duration and original chunk hashes/times must match. Copied/modified chunk arrays cannot recreate that authority. A short decode that does not reach video end, missing or failed chunks, offset/separate tracks, unknown video duration, cancellation and decoder errors retain their existing behavior. There is no larger arbitrary time tolerance. Actual intervals still end at decoded audio, and the metadata-only gap remains visible in diagnostics.

Legacy combined-mode classification and all ASR/fusion request identities stay unchanged. Offline labeled replay still conservatively reports full-container coverage as partial for this new reason; no unobserved evidence reference is fabricated. This distinction must remain explicit when evaluating coverage versus successful processing of available audio.

Keep normal-share enrollment off until the revised request contract has live validation and useful location results. Recognizing all native venue spellings remains unresolved; audio alone also cannot supply a name that appears only on screen. Do not silently replace the user's chosen transcription provider or feed reference answers into prompts. Any further paid diagnostic must be bounded and separately recorded; do not reset/reuse prior tickets or change generations to force a replay. A normal app share/explicit Retry is still required to test selection, Google confirmation, saving and clearing activity cards. The existing app already advertises the required media recovery capability; no native rebuild is needed for the audio policy.
