# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && install -d -o node -g node -m 0700 /var/lib/sipper-gateway
COPY src/ ./src/
USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/main.mjs"]
