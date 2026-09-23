# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────────────────────
# Frontend Dockerfile — 4 stages: base → dev | build → prod
#
# Perf optimizations (2026-06-02):
#   1. .dockerignore drops the 230MB node_modules COPY context (236MB → ~5MB).
#   2. BuildKit cache mount on /root/.npm persists the package tarballs across
#      builds — even after package-lock.json changes, only the diff downloads.
#      Requires DOCKER_BUILDKIT=1 (default in Docker 23+) and the syntax pin
#      at the top of this file.
#   3. `npm ci` is intentionally NOT used because it discards the cache mount's
#      benefit (clean install every time). `npm install --no-audit --no-fund`
#      keeps the cache warm and skips the audit RPC that adds 5-10s.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund

FROM base AS dev
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM base AS build
# The build's live set outgrew Node's default heap on the t3.small (980 MB,
# measured 2026-09-22: "Reached heap limit" in the prerender step after the
# bundle was written). 1536 MB fits the box's RAM + 2 GB swap; the prod image
# build runs one service at a time (deploy.sh), so nothing else competes.
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY . .
RUN npm run build

FROM nginx:alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
