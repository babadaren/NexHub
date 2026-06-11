FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile=false
COPY backend backend
COPY frontend frontend
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
RUN pnpm install --prod --filter @proxy-control-center/backend --frozen-lockfile=false
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist backend/public
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
