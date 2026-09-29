# Server runtime compatibility — 2026-09-29

The production server image moves from `node:20-bookworm-slim` to
`node:22-trixie-slim`. Root CI tests use Node 22. Firebase Functions remain a
separate deployment package with their existing Node 20 engine and isolated
Node 20 CI job.

## Reason and scope

An offline comparison used identical actual AAC/video bytes. FFprobe
5.1.7 reports AAC container and stream origin `-0.114694`; FFprobe 6.0 reports
zero and first-packet Skip Samples metadata of 5,058 samples at 44,100 Hz. Video
origin is zero in both, and durations agree. This is a decoder presentation and
AAC priming compatibility difference, not permission to relax timeline checks.
The earlier generated smoke encoded and decoded with the same runtime, so its
success did not establish compatibility with these fixed bytes. See the
[production finding](2026-09-28-media-name-and-scan-plan.md#production-finding-and-bounded-rollback).

The production base uses the official
[Node 22 Trixie slim image](https://raw.githubusercontent.com/nodejs/docker-node/main/22/trixie-slim/Dockerfile).
Debian Trixie supplies FFmpeg 7.1.5, the preferred 7.1.x toolchain; the
compatibility floor is 6. Exact distro patch
versions remain resolved at build time and recorded in the image, as before.
The floating base tag and apt packages are not a claim of byte-reproducible
builds; use the tested image archive and image ID for release provenance.

The runtime update and fixed-fixture regression coverage preserve the existing
dependency pins: `yt-dlp==2026.08.19`, `curl_cffi==0.13.0`, and all JavaScript
manifests and lockfiles. The hosting plan remains on the free tier. Media source
priority, timeline validation, decoder arguments, deadlines, resource caps,
models, rollout flags, and paid-operation fences are unchanged. Media
enrollment remains off, and the withdrawn AAC-driven video reselection remains
disabled. Only the root server moves to the new Node/OS runtime; Functions
retain Node 20.

## Offline image gates

The image includes `/usr/local/bin/mapd-runtime-check.py`. The build runs it and
the real decoder smoke with BuildKit `RUN --network=none`. After the
build, Docker CI repeats both inside the final image using `--network none`,
then runs the existing entry-point and authentication smoke under the same
network isolation. Package installation still needs build-time package access;
the readiness and media checks have no egress and use no production credentials.

The readiness check fails on missing or unusable tools and verifies:

- Installed `ffmpeg -version` and `ffprobe -version` each report major version
  6 or later, with exactly matching full version tokens, including distro suffixes.
- The actual Node executable reports major version 22.
- Python imports `yt_dlp`, `curl_cffi`, and `curl_cffi.requests`; distribution
  metadata and imported versions match the existing pins. yt-dlp's calendar
  version normalization in package metadata is accounted for explicitly.
- The actual `yt-dlp --ignore-config --version` command matches its pin. A native
  curl handle can be constructed and closed without a request.

The readiness JSON reports actual Node, Python, FFmpeg, ffprobe, yt-dlp, and
curl_cffi versions. CI retains it and the decoder smoke output in
`artifacts/runtime-compatibility.txt` alongside the tested image archive, image
ID, source revision, and archive checksum. Existing full FFmpeg/ffprobe version
reports remain at `/usr/local/share/mapd-ffmpeg-version.txt` and
`/usr/local/share/mapd-ffprobe-version.txt` inside the image. A version report
alone does not substitute for running the binaries.

## Compatibility risks and merge evidence

- **OS and decoder:** Bookworm to Trixie changes system libraries, codecs, and
  FFmpeg/ffprobe behavior, including timestamp and error reporting. Matching
  versions and generated-media checks establish executable readiness, but do
  not establish fixed-file AAC compatibility, production throughput, or venue
  recognition. All current strict rejection checks must remain intact.
- **Python:** Trixie's Python 3.13 replaces Bookworm's Python 3.11. Pinned packages
  and their native/transitive dependencies may have interpreter, wheel, or ABI
  incompatibilities. Keep the existing pins and pip installation behavior;
  package installation, imports, CLI checks, and native curl initialization must
  succeed in the exact Linux image. Offline readiness does not prove platform
  access, TLS behavior against providers, or successful live extraction.
- **Node:** Node 20 to 22 can change V8, HTTP/fetch, dependency, and native-module
  behavior. The root Node 22 test, contract, regression, load, emulator, and final
  image startup checks are the release evidence. Functions keep their separate
  Node 20 tests and deployment runtime.

Fixed synthetic fixtures (no user media),
`tests/media/fixtures/aac-priming-5058.m4a` and
`tests/media/fixtures/zero-origin-video.mp4`, are integrated through
`tests/media/priming-smoke.cjs` into the shared `tests/media/smoke.cjs` entry
point. Both Docker smoke invocations therefore exercise the same fixed bytes.
The HE-AAC 44,100 Hz sine tone was generated with Apple AudioToolbox, then
fragmented with a single edit trimming 5,058 samples. It reproduces the
compatibility difference: FFprobe 5.1 reports AAC origin `-0.114694`, while 6
reports zero; both report duration `3.157914`.

The fixed-fixture check validates byte hashes, zero presentation origin,
first-packet PTS of `-5058`, exactly 5,058 skipped priming samples, and strict
audio/video alignment. Decoding must produce three seconds of continuous,
non-silent PCM covering the video. Existing invalid-timeline and corruption
rejection tests remain in the smoke entry point. Generating fresh fixtures with
each runtime would hide the original difference.

Local FFmpeg/ffprobe 6 verification passes the fixed-fixture check. Version 5.1
rejects it as expected under the unchanged strict validation. Hosted Trixie
7.1 verification remains pending: the exact Docker CI build, offline readiness,
fixed-fixture and generated-media smoke, and entry-point checks must pass
before merge. Local results do not establish production throughput or live
recognition readiness on the free hosting plan.
