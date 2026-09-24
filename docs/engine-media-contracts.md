# Selective media evidence contracts

Implementation version: `media-v1` / `media-evidence-v1`; frame policy `scene-grid-v1`. The rollout remains off by default. See the September 21 implementation report for validation and activation gates.

## Boundaries and data ownership

`mediaSource` accepts a server-read post and returns an internal descriptor for a public direct MP4/WebM rendition. Its capability cannot be created by request JSON; attaching it to extracted metadata is non-enumerable. The downloader validates public DNS at connection time and on redirects. A blocked or expired rendition ends this attempt; there is no automatic source refresh/fallback loop.

`publicMediaDownload` owns a private temporary workspace. `mediaProcess`, `audioDecode` and `frameSelector` consume local files under bounded process lifetimes. Audio and normalized images handed to shared producers are copied into producer-owned buffers. No worker-local path is serialized to remote followers. Cleanup retains active process references, waits for close after cancellation, and conservatively retains orphan directories if process identity cannot be established.

## Transcription adapter

Trusted server code registers adapters with:

```js
{
  id, model, version,
  capabilities: { timing: 'chunk' /* or native */, language: false },
  async transcribeChunk({
    audioBytes, audioSha256, startMs, endMs,
    languageHint, signal, deadline, model
  }) {
    return { text, language: null, segments, usage: null };
  }
}
```

Audio is bounded mono 16 kHz PCM WAV. `startMs`/`endMs` describe actual source samples, not word timestamps. A native-timing adapter must return absolute source offsets contained within its chunk. Missing language/usage stays null. No automatic translation, fallback provider, or transport retry is allowed. The initial adapter pins `gpt-4o-mini-transcribe-2025-12-15`, JSON output, and no guessed-name prompts. A second fake adapter exercises interchangeability in tests; adding a live provider also requires trusted policy, price/rate-key registration and evaluation.

The facade returns `provider`, `model`, `adapterVersion`, `mediaDigest`, `language`, `segments`, `text`, `coverage`, `failures`, and `retryOperations`. Segment evidence IDs include the audio hash and source offset. Cached results exclude provider billing usage. Physical-call accounting occurs once at the provider boundary, including reported usage on a malformed transcript response.

`coverage` contains a status (`unattempted`, `unavailable`, `partial`, `complete`, `failed`), real covered intervals and optional machine-readable reason. Subtitle cues only cover their actual timed intervals. Missing cues do not imply silence. Fragmented gaps use bounded real-PCM grid chunks; truncated audio or a tighter policy can leave explicit uncovered intervals.

## Frame and fusion evidence

Frames carry source digest, image digest, decoder timestamp, dimensions, normalized crop coordinates and local bytes. Vision consumes at most eight frames per request, at most two batches and sixteen frames per attempt. Each normalized frame is at most 1.5 MiB; each batch is at most 12 MiB. Scene/grid ranking is an image heuristic, not an OCR detector. Real brief-sign recall remains an evaluation gate.

The video-specific response contains literal visual observations and place candidates. Each name and nonempty geographic field requires a validated reference with `evidenceId`, literal `quote`, `supports` (`name`, `city`, `country`, `address`), and a normalized frame `region` when appropriate. Validation checks reference existence, quotes and geometry; it cannot prove that model recognition or semantic association is correct.

Final `grounded-crossmodal-v2` fusion combines caption, timed speech/subtitles and validated visual observations. Baseline candidates are hypotheses, not evidence. The result is `{places, contradictions}`. A contradiction names a baseline venue and cites literal evidence; affected candidates require confirmation. New media candidates always require selection. Evidence quotes and frame/audio bodies are stripped before mobile job publication.

## Recovery contract

A saved pin is independent of unfinished optional analysis. Server jobs can contain:

```json
{"analysisRecovery":{"version":1,"status":"incomplete","reason":"media_incomplete","canRetry":true}}
```

- `complete` plus recovery means all known places were saved, but analysis was incomplete.
- `failed` plus `partial_save` means identified places remain unsaved; its total counts those known places only.
- `needs_selection` keeps ordinary candidates and can separately carry recovery.
- Explicit dismissal clears recovery and stays dismissed across snapshots/restart. SQLite distinguishes an authoritative clear (JSON `null`) from an unknown decision (SQL NULL), preserving the correct newer retry anchor.

New clients capture `clientCapabilities: ["mediaRecoveryV1"]`. Server cohort, feature policy and compatible fleet controls are separately required. Capability alone never authorizes media processing. Clients may supply `retryOf` and `retryKind: "analysis"` on a new explicit retry. Internal generation records cannot be client-written.

An internal retry record is `{kind, retryKey, generation}` for `asr_chunk`, `video_vision`, or `media_fusion`. A positive generation is fenced by the durable operation store. Null retains a pending operation identity only: a later explicit retry must resolve its durable status before authorizing a failed/uncertain generation. Running work joins; successful work is reused. No recovery timer, cache expiry, app reopening or dismissal starts a new attempt. Validated retry ancestry preserves recovery across admission/delivery failures, with bounded traversal and owner/URL checks.

## Policy and accounting

Defaults: video 180 seconds, download 64 MiB, workspace 128 MiB, media allowance 60 seconds within the existing job deadline, reserved matching/save tail 30 seconds, per-request maximum 20 seconds, audio chunks 20 seconds with 1-second overlap, two concurrent ASR chunks, four media provider slots and one local decoder slot. Exact bounds and relationships are validated in `lib/media/mediaConfig.js` and recorded in the job snapshot.

Public evidence can coalesce by actual input/model/prompt/policy identity. User-private context has a separate scope. Successful evidence artifacts have a maximum 24-hour TTL; completed manifests allow one-hour freshness reuse. Failed/partial manifests are not success-cached. Monetary accounting is observation-only. Technical deadlines/capacity, provider cooldowns and an explicit emergency stop remain independent of spending.
