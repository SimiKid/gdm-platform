FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY frontend/admin-dashboard/package.json frontend/admin-dashboard/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter admin-dashboard...

COPY packages/shared packages/shared
COPY frontend/admin-dashboard frontend/admin-dashboard

ARG VITE_SESSION_MANAGER_URL=/api
ARG VITE_PARTICIPANT_URL=http://localhost:3000
ENV VITE_SESSION_MANAGER_URL=${VITE_SESSION_MANAGER_URL}
ENV VITE_PARTICIPANT_URL=${VITE_PARTICIPANT_URL}

RUN pnpm --filter @gdm/shared build
RUN pnpm --filter admin-dashboard build

FROM nginx:alpine

COPY --from=build /app/frontend/admin-dashboard/dist /usr/share/nginx/html
COPY frontend/admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
