# syntax=docker/dockerfile:1
FROM node:22-trixie-slim

# Install local-only video tools and report exact distro-resolved versions in the image.
# Security patch revisions follow the base image; the report is part of every build artifact.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp==2026.08.19 curl_cffi==0.13.0 && \
    ffmpeg -version > /usr/local/share/mapd-ffmpeg-version.txt && \
    ffprobe -version > /usr/local/share/mapd-ffprobe-version.txt && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV EXTRACTOR_VERSION=2026.08.19
ENV EXTRACTOR_CURL_VERSION=0.13.0

# Check the installed tools, not just their saved version reports. CI reuses this
# check in the final image with --network none. No URLs or credentials are used.
COPY <<'PY' /usr/local/bin/mapd-runtime-check.py
import json
import os
import platform
import re
import subprocess
from importlib.metadata import version

import curl_cffi
from curl_cffi import requests
import yt_dlp
from yt_dlp.version import __version__ as yt_dlp_version


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def output(*args):
    return subprocess.check_output(
        args, text=True, stderr=subprocess.STDOUT, timeout=10
    ).strip()


media_versions = {}
for binary in ("ffmpeg", "ffprobe"):
    match = re.match(rf"^{binary} version ((\d+)\.\S+)(?:\s|$)", output(binary, "-version"))
    require(match is not None, f"Unrecognized {binary} version")
    require(int(match[2]) >= 6, f"{binary} >= 6 required; Trixie 7.1.x preferred")
    media_versions[binary] = match[1]
require(media_versions["ffmpeg"] == media_versions["ffprobe"], "FFmpeg/ffprobe versions must match")

node_version = output("node", "--version")
require(node_version.startswith("v22."), "Production server requires Node 22")
expected_yt_dlp = os.environ["EXTRACTOR_VERSION"]
expected_curl = os.environ["EXTRACTOR_CURL_VERSION"]
# Distribution metadata normalizes calendar versions (2026.08.19 -> 2026.8.19).
normalized_yt_dlp = ".".join(str(int(part)) for part in expected_yt_dlp.split("."))
require(version("yt-dlp") == normalized_yt_dlp, "yt-dlp distribution pin mismatch")
require(yt_dlp_version == expected_yt_dlp, "yt-dlp import pin mismatch")
require(output("yt-dlp", "--ignore-config", "--version") == expected_yt_dlp, "yt-dlp CLI pin mismatch")
require(version("curl_cffi") == expected_curl, "curl_cffi distribution pin mismatch")
require(curl_cffi.__version__ == expected_curl, "curl_cffi import pin mismatch")
# Construct and close a native handle without issuing a request.
curl_cffi.Curl().close()
print(json.dumps({
    "node": node_version, "python": platform.python_version(),
    **media_versions, "yt_dlp": yt_dlp_version, "curl_cffi": curl_cffi.__version__,
    "ready": True,
}))
PY

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Exercise the shipped binaries and production dependencies on generated media.
# No credentials, provider requests, or external media are required.
RUN --network=none python3 /usr/local/bin/mapd-runtime-check.py && \
    node tests/media/smoke.cjs

EXPOSE 3000

CMD ["node", "index.js"]
