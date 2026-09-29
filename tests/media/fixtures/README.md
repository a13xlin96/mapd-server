# Fixed decoder compatibility fixtures

These files contain only a generated 440 Hz tone and three seconds of black video. They contain no user media, captions, restaurant names, network URLs, or credentials. Created for this repository's tests.

Use the **same checked-in bytes** on each tested runtime. Regenerating with the runtime under test hides compatibility differences. `../priming-smoke.cjs` verifies SHA-256 before probing and decoding.

- `aac-priming-5058.m4a`: HE-AAC stereo at 44,100 Hz, fragmented MP4, a single edit-list entry with media time 5,058 samples and duration zero (to end). The edit discards 114.694ms of encoded preroll. FFprobe 5.1.7 reports container/stream start `-0.114694`; FFprobe 6.0 reports presentation start zero and supplies the first packet's `Skip Samples: 5058` side data. Both report duration `3.157914`. Strict alignment must reject the older interpretation; do not add a guessed tolerance.
- `zero-origin-video.mp4`: MPEG-4 black frames, 320x180, 30fps, 3,000ms, no audio, origin zero.

The tone was synthesized with FFmpeg 6.0's macOS AudioToolbox encoder (`sine=frequency=440:sample_rate=44100:duration=3`, stereo, `aac_at`, profile 4, 64kbps). A stream copy with `empty_moov+default_base_moof+frag_keyframe` and 1,000,000us fragments created the fragmented container. A single `edts/elst` box (version 0; one entry; segment duration 0; media time 5058; rate 1.0) was inserted in `trak`, updating only its and `moov`'s sizes. No timestamp-normalization option is used when reading these fixtures.

The video was synthesized from `color=c=black:s=320x180:r=30:d=3` with codec `mpeg4`. Generator/runtime versions can change encoded bytes; any intentional fixture update requires reviewing the new hashes and checking both old and new decoder behavior again.

Acceptance: exact priming metadata, zero presentation origin, strict same-origin alignment, three seconds of continuous nonzero PCM, plus the existing discontinuity/corruption/stream-selection rejection checks. This proves this compatibility case only, not speech recognition or production scan throughput.
