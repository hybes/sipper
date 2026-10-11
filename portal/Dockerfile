# syntax=docker/dockerfile:1
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
ENV CI=true NUXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.5.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 NUXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/server/lib ./server/lib
COPY --from=build /app/server/db ./server/db
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts/migrate.ts /app/scripts/worker.ts /app/scripts/push-worker.ts /app/scripts/meeting-worker.ts /app/scripts/worker-health.ts /app/scripts/grant-owner.ts /app/scripts/preflight.ts /app/scripts/container-entrypoint.sh ./scripts/
USER node
EXPOSE 3100
ENTRYPOINT ["sh", "scripts/container-entrypoint.sh"]
CMD ["portal"]
