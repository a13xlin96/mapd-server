FROM node:20-slim

# Install Python and yt-dlp
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-dev gcc libcurl4-openssl-dev libssl-dev && \
    pip3 install --break-system-packages yt-dlp curl_cffi && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
