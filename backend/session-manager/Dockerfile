FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY backend/session-manager/package.json backend/session-manager/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter session-manager...

COPY packages/shared packages/shared
COPY backend/session-manager backend/session-manager

RUN pnpm --filter @gdm/shared build
RUN pnpm --filter session-manager build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/backend/session-manager/package.json backend/session-manager/package.json
COPY --from=build /app/backend/session-manager/node_modules backend/session-manager/node_modules
COPY --from=build /app/backend/session-manager/prisma backend/session-manager/prisma
COPY --from=build /app/backend/session-manager/dist backend/session-manager/dist

EXPOSE 3001

CMD ["sh", "-c", "backend/session-manager/node_modules/.bin/prisma migrate deploy --schema backend/session-manager/prisma/schema.prisma && node backend/session-manager/dist/main.js"]
