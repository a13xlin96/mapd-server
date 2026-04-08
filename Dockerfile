FROM node:20

# Install Python and yt-dlp with impersonation support
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    python3 -m venv /opt/ytdlp-env && \
    /opt/ytdlp-env/bin/pip install yt-dlp "curl_cffi>=0.7" && \
    ln -sf /opt/ytdlp-env/bin/yt-dlp /usr/local/bin/yt-dlp && \
    yt-dlp --list-impersonate-targets 2>&1 | head -5 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
