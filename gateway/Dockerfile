# syntax=docker/dockerfile:1
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && install -d -o node -g node -m 0700 /var/lib/sipper-gateway
COPY src/ ./src/
USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/main.mjs"]
