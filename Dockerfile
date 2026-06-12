# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY backend backend
COPY frontend frontend
RUN pnpm build
RUN pnpm --filter @proxy-control-center/backend --prod deploy --legacy /prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8080
ENV DATA_DIR=/app/data
ENV PUBLIC_DIR=/app/backend/public

RUN addgroup -S pcc && adduser -S pcc -G pcc

COPY --from=build /prod ./
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/migrations backend/migrations
COPY --from=build /app/frontend/dist backend/public

RUN mkdir -p /app/data \
  && chown -R pcc:pcc /app \
  && ln -s /app/backend/dist/cli.js /usr/local/bin/proxy-control-center

USER pcc
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/server.js"]
