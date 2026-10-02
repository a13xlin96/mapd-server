# Audio-only live qualification findings

The reviewed audio-only server implementation (PR 27, merge 0f870e3) was deployed to Render Free with normal-share enrollment disabled. Two new one-use diagnostics performed no pin/job writes and no Google matching. Neither historical tickets nor failed paid-operation generations were reset.

## Measured production results

- Pho reel DdwKi3iJlBq: 37.7 seconds total, four successful ASR requests, one successful fusion request, zero frame/vision calls. The model returned Pho Gia Trinh, Pho Ga Nguyet and Pho Tin. Against the user's reference names, two are misheard and one expected name is absent. The retained transcript itself contains these spellings; extraction did not introduce them. Reference names were not sent as prompts. This is not an accuracy pass.
- Crab reel DauhHNHRXIw: 27.3 seconds total, two successful ASR requests, zero frame/vision calls. Fusion returned a response rejected as `format_framing`; the raw response was not retained, so its precise wrapper/refusal/content cannot be reconstructed. No places were returned. The saved ASR text discusses crab dishes and Ho Chi Minh but contains no restaurant name; the independent reference identifies Quán Thuý 94 from an on-screen sign. Audio-only cannot establish that name from this transcript. This is not an end-to-end pass.
- Both audio intervals ended less than one millisecond before the container duration: 0.125 ms and 0.6895 ms. Real local decoding of retained source assets reproduces these exact differences. The old facade treated each tiny trailing discrepancy as incomplete audio.
- Cost telemetry contains only partial estimates (ASR: $0.0030575 and $0.00101625 under the configured price table). Fusion and source calls lack configured rates. These figures are not total per-link costs or reconciled bills.

## Coverage correction

Only a sole trailing gap below one millisecond, with contiguous successful coverage starting at zero, actual audio chunks, and no failures/cancellation, is considered complete at millisecond precision. Its reason is `submillisecond_tail`. Actual evidence intervals and timestamps remain unchanged; no samples or words are invented or padded. Initial/internal gaps, tails of one millisecond or more, missing audio, and provider failures remain incomplete. Physical ASR requests, shared identities, caches and retry authority are unchanged.

Sanitized live diagnostic reports preserve that reason. Offline replay retains its separately identified unobserved tail and accepts only the corresponding final one-millisecond window at its integer timestamp precision; other incomplete observations cannot claim complete.

The real-decoder smoke now uses the real transcription facade with stub provider responses. It previously fabricated complete coverage, hiding this mismatch. Decoder/provider-stub checks demonstrate interval handling, not recognition accuracy.

## Response-format prevention

For the new audio-only mode, the fusion request declares one structured data output instead of relying on the model to wrap JSON in ordinary prose. This is prevention of the observed format-error class, not proof of what the lost response contained. The same model and literal-evidence/grounding checks remain; no second request or automatic repair loop is introduced. The prior combined mode keeps its existing request contract.

Anthropic documents forced single-tool output for supported models: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools. The pinned SDK supports tools/tool_choice; this declaration is used to receive structured data and does not execute any external tool.

## Remaining qualification

Keep normal-share enrollment off until the revised request contract has live validation and useful location results. Recognizing all native venue spellings remains unresolved; audio alone also cannot supply a name that appears only on screen. Do not silently replace the user's chosen transcription provider or feed reference answers into prompts. Any further paid diagnostic must be bounded and separately recorded; do not reset/reuse prior tickets or change generations to force a replay. A normal app share/explicit Retry is still required to test selection, Google confirmation, saving and clearing activity cards. The existing app already advertises the required media recovery capability; no native rebuild is needed for the audio policy.
