FROM node:20-slim

# Install Python and yt-dlp
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp==2026.08.19 curl_cffi==0.13.0 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV EXTRACTOR_VERSION=2026.08.19
ENV EXTRACTOR_CURL_VERSION=0.13.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
