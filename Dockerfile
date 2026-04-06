FROM node:20-slim

# Install Python, yt-dlp, and Playwright browser dependencies
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

# Install Playwright Chromium browser
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
