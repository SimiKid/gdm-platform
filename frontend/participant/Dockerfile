# ── Stage 1: Build ────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace root files for pnpm
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY frontend/participant/package.json frontend/participant/

# Install only the participant workspace dependencies
RUN pnpm install --frozen-lockfile --filter participant

# Copy source and build
COPY frontend/participant/ frontend/participant/
RUN pnpm --filter participant run build

# ── Stage 2: Serve ────────────────────────────────────
FROM nginx:alpine

COPY --from=build /app/frontend/participant/dist /usr/share/nginx/html
COPY frontend/participant/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
