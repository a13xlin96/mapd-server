FROM node:20-bookworm-slim

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

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Exercise the shipped binaries and production dependencies on generated media.
# No credentials, provider requests, or external media are required.
RUN node tests/media/smoke.cjs

EXPOSE 3000

CMD ["node", "index.js"]
