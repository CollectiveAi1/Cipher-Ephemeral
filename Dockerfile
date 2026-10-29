# Cipher's server: a long-lived Node process with a WebSocket gateway, a SQLite file
# and a background reaper. It needs a real container, not a serverless function.
FROM node:24-alpine

WORKDIR /app

# Install first so dependency layers cache independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The database lives on a mounted volume so it survives redeploys.
ENV NODE_ENV=production \
    CIPHER_PORT=8787 \
    CIPHER_DB_PATH=/data/cipher.db

EXPOSE 8787

# Node 24 runs TypeScript directly, so there is no server build step.
CMD ["node", "--env-file-if-exists=.env", "server/index.ts"]
