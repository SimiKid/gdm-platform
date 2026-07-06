FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY backend/chat-service/package.json backend/chat-service/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter chat-service...

COPY packages/shared packages/shared
COPY backend/chat-service backend/chat-service

RUN pnpm --filter @gdm/shared build
RUN pnpm --filter chat-service build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/backend/chat-service/package.json backend/chat-service/package.json
COPY --from=build /app/backend/chat-service/node_modules backend/chat-service/node_modules
COPY --from=build /app/backend/chat-service/dist backend/chat-service/dist

EXPOSE 3002

CMD ["node", "backend/chat-service/dist/main.js"]
