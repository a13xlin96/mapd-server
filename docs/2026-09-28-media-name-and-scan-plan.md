# Media recovery: name context and free-tier scan performance

## Scope and acceptance

The supplied reel produced one matching name from four user references. Four stored, attributed ASR chunks showed the incorrect names already existed before fusion. Its visual scan exhausted its phase time before encoding or any vision call. Improve these two stages while retaining the requested transcription model and free hosting.

1. Add bounded public-source spelling context to the existing transcription call. Keep language automatic, since English narration can mention Vietnamese names. Do not send private share text, user notes, expected test answers or invented spellings. Prompt/context changes must partition shared artifacts and manifests; empty context must preserve existing reuse. Report added text-token cost, without adding calls or monetary caps.
2. Benchmark cheaper scan processing on saved media. Preserve six-per-second temporal sampling, cut detection, frame/resource bounds, original timestamps, brief-overlay detection and native-resolution final frame extraction. Prefer computational improvements with unchanged selected frames. Reject alternatives that trade away brief visual clues without measured evidence. Do not lengthen deadlines or upgrade hosting.
3. Add focused regressions and generated real-decoder coverage. Run the full server suite, offline engine cases and an independent adversarial review, including cache identities, trust boundaries, cost, failure recovery, media safety and selection behavior.
4. Publish the reviewed server-only change through the existing CI/deployment workflow. Keep pilot/public media enrollment off until live accuracy and visual readiness succeed. No new mobile build is needed. A subsequent controlled diagnostic needs a new one-use ticket; never reset/reinvoke old tickets or advance paid-operation generations to bypass fences.

## Downstream effects

- Prompted transcription can improve spelling but is not proof of correct recognition. Public metadata is untrusted context, not spoken evidence, and should not override what is heard.
- New context produces a different legitimate ASR artifact identity and can incur fresh paid work on an eligible attempt. Completed old results remain reusable on their original identities. Failed app jobs are never automatically retried.
- Changing visual analysis pixels can change scene scores and frame choices even when temporal sampling remains constant. Benchmark and test brief signs, rotations, VFR, clipping and low-contrast detail before shipping a scan change.
- Local timing is not a measured production speedup. Partial audio/visual results must remain explicitly partial, with matching and save time protected.

## Sources

OpenAI's [file transcription guidance](https://developers.openai.com/api/docs/guides/speech-to-text) supports contextual prompting for the existing GPT-4o mini transcription model, including names and vocabulary. The [API reference](https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create) documents prompt and language inputs. No model migration is part of this change.

## Implemented scope and benchmark outcome

- The ASR facade accepts a frozen, provider-neutral `context`. The builder uses only the public extractor's title and description; the coordinator captures it before awaits. No `ogData` (which may carry private notes), baseline guesses, user answer keys, or forced language enter the context. At most 32 atomic lexical items retain Unicode accents; unsafe/oversized lines are omitted. This deliberately conservative approach loses phrase order and may omit useful text. It does not prove improved recognition or prevent every semantic prompt attack.
- Exact prompt bytes and context version partition paid/shared ASR identity and the completed media manifest. A missing context preserves old identities and provider requests. Reported usage remains authoritative, with bounded text-input reservation when prompting; no second ASR pass or increased concurrency is added.
- Removing the duplicate scene metric, using fast bilinear scaling, or both did **not** consistently improve local scan performance. They also changed frame ranking. None of these filter changes shipped; six-per-second scanning, cut detection, native selected-frame encoding and all cutoffs stay unchanged.
- Instead, a narrowly qualified source selection avoids an unknown/oversized video when yt-dlp provides an eligible progressive AAC track for the explicitly same post. The selected alternative has known integral dimensions, at least 640px on its short side and no more than 1280px on its long side. The largest qualified rendition wins. Known muxed audio and already-bounded picks keep precedence. Tiny previews, missing audio authority, invalid tracks, HTML-only results and unsupported live/carousel media preserve the old behavior.
- Separate audio still must pass the existing decoder duration/origin checks. It shares the single acquisition deadline and cumulative download/workspace budget; failure preserves useful frames and reports incomplete audio. This path may require one additional bounded audio-file request compared with a muxed source, and may fail alignment even when the former unknown source happened to carry usable audio. It performs no fallback download and no new metadata retry.
- Candidate audio URLs are checked against the full accepted video inventory, not just its four-item shortlist, so a duplicate URL cannot authorize reselection.
- Source-byte identities already distinguish changed renditions. Existing complete manifests remain reusable unless the prompt input differs; no failed job is automatically replayed and no paid-operation generation/fence is reset.

### Local timing, not production accuracy

Four alternating scans compared a saved 28-second 720x1280 H.264 clip against a generated 1080x1920 rendition of that same clip. Median scan times were 1,287ms and 1,743ms respectively (about 26% lower for 720p). This is a local synthetic rendition comparison, not a measured gain on the user's 62-second reel or Render Free. Source encoding and CDN availability differ in production. Frame selection may differ across renditions even though the algorithm is unchanged. Public deployment/pilot readiness requires an actual controlled result; do not present these tests as recall/accuracy evidence.

## Review and verification

The independent review found a selector edge case: a known small unknown-audio video could be replaced with a larger silent rendition. Selection now preserves known small picks and requires lower pixel area for any known oversized replacement, including unusually narrow/tall videos. Four regressions cover this.

The generated decoder check exercises 720p video selection, a separate AAC file, strict timeline alignment and a 300ms visual clue. The clue survives; final frames use the unchanged byte-safe 945x531 geometry for 16:9 sources (not full 1280x720 and not the 320px scan). Local FFmpeg 6 smoke, full unit/integration tests and offline engine cases pass; production FFmpeg 5.1 is checked separately in hosted Docker CI. Live recognition is still unproven, so media enrollment stays off.

## Live follow-up: optional source duration

The first controlled run after PR 18 still selected the original unknown-size video. A single metadata-only inspection found eligible 720x1280 versions and same-post AAC, but no duration field. The selector's metadata-duration prerequisite prevented the optimization. Remove only that prerequisite; preserve the decoder's actual duration, track-origin, alignment and resource validation. The generated real-decoder smoke now omits metadata duration and still must verify 720p video, AAC alignment and the brief clue. No processing/time/size limits are relaxed.

The same controlled run matched two of the four supplied reference names, with a different miss from the prior run; it does not establish an accuracy improvement. Visual scanning still timed out, and public/pilot enrollment remains off.

A local, no-AI acquisition of the actual supplied reel then selected 720x1280 video (3,272,797 bytes) plus aligned AAC (522,870 bytes), compared with the prior diagnostic's 18,698,856-byte unknown-size source. Scanning and encoding completed with 16 frames at the unchanged 531x945 final geometry. These are local functional/acquisition observations, not yet a Render timing or recognition result. Independent review approved the four-file follow-up; 249 focused tests and real-decoder smoke passed.
