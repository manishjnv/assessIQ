# syntax=docker/dockerfile:1.7

# AssessIQ — assessiq-frontend container.
# Phase 0 closure carry-over (browseable site). Multi-stage:
#   1. deps     — pnpm install --filter '@assessiq/web...' (workspace closure)
#   2. builder  — apps/web `tsc -b && vite build` → /app/apps/web/dist
#   3. runtime  — nginx:alpine + SPA fallback config + static dist/
# @assessiq/ui-system is a source-only workspace dep (main: ./src/index.ts);
# no separate build step. Tailwind scans modules/17-ui-system/src in addition
# to apps/web/src per apps/web/tailwind.config.ts content paths.
# Build context = repo root (set in compose `build.context: ..`).

ARG NODE_VERSION=22-alpine
ARG NGINX_VERSION=1.27-alpine

# ─── Stage 1: deps — install pnpm workspace closure for @assessiq/web ────────
FROM node:${NODE_VERSION} AS deps

RUN corepack enable

WORKDIR /app

# Workspace metadata. pnpm needs the lockfile + every workspace-closure member's
# package.json to resolve the install graph for --filter '@assessiq/web...'.
# Phase 1 G1.D adds @assessiq/candidate-ui and @assessiq/help-system to the
# workspace closure (apps/web depends on both); add their package.json + 16's
# nested dep on @assessiq/{core,tenancy,ui-system}.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json                  ./apps/web/
COPY modules/17-ui-system/package.json      ./modules/17-ui-system/
COPY modules/11-candidate-ui/package.json   ./modules/11-candidate-ui/
COPY modules/16-help-system/package.json    ./modules/16-help-system/
COPY modules/00-core/package.json           ./modules/00-core/
COPY modules/02-tenancy/package.json        ./modules/02-tenancy/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '@assessiq/web...'

# ─── Stage 2: builder — vite build → /app/apps/web/dist ──────────────────────
FROM node:${NODE_VERSION} AS builder

RUN corepack enable

WORKDIR /app

# Carry deps tree forward (workspace metadata + node_modules symlink farm).
COPY --from=deps /app/. ./

# Source overlay. apps/web ships tsconfig project refs (tsconfig.app/node.json),
# vite.config.ts, tailwind.config.ts, postcss.config.js, index.html — copy the
# whole tree. Same for the source-only workspace deps. Doing this AFTER the
# deps COPY means a source-only edit doesn't bust the (heavier) deps layer.
# Phase 1 G1.D: candidate-ui + help-system source must land here for tsc to
# resolve their barrels. 00-core + 02-tenancy are transitive deps of help-system.
COPY apps/web/                              ./apps/web/
COPY modules/17-ui-system/                  ./modules/17-ui-system/
COPY modules/11-candidate-ui/               ./modules/11-candidate-ui/
COPY modules/16-help-system/                ./modules/16-help-system/
COPY modules/00-core/                       ./modules/00-core/
COPY modules/02-tenancy/                    ./modules/02-tenancy/
COPY tsconfig.base.json                     ./

# Build script: `tsc -b && vite build` (apps/web/package.json:8). Vite emits
# hashed assets to apps/web/dist/.
RUN pnpm --filter @assessiq/web build

# ─── Stage 3: runtime — nginx:alpine + SPA fallback ──────────────────────────
FROM nginx:${NGINX_VERSION} AS runtime

# Replace the stock default.conf with the AssessIQ SPA fallback config.
# The base image's default.conf serves a stock Welcome page from
# /usr/share/nginx/html — removing it before COPY prevents config conflicts.
RUN rm /etc/nginx/conf.d/default.conf
COPY infra/docker/assessiq-frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Static assets. Vite outputs hashed filenames, so cache-bust safety is
# already built into the asset filenames.
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

# Inherit nginx:alpine's default ENTRYPOINT + CMD. The master runs as root
# (required to bind :80) and spawns workers as the `nginx` user (uid 101).
