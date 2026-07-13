# ── Stage 1: Build ────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /app

# Copy workspace root files for pnpm
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY frontend/participant/package.json frontend/participant/

# Install only the participant workspace dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --filter participant...

# Copy source and build
COPY packages/shared packages/shared
COPY frontend/participant/ frontend/participant/

ARG VITE_MATRIX_HOMESERVER=/
ARG VITE_SESSION_MANAGER_URL=/api
ENV VITE_MATRIX_HOMESERVER=${VITE_MATRIX_HOMESERVER}
ENV VITE_SESSION_MANAGER_URL=${VITE_SESSION_MANAGER_URL}

RUN pnpm --filter @gdm/shared build
RUN pnpm --filter participant run build

# ── Stage 2: Serve ────────────────────────────────────
FROM nginx:alpine

COPY --from=build /app/frontend/participant/dist /usr/share/nginx/html
COPY frontend/participant/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
