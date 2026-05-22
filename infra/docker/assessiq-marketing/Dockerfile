# syntax=docker/dockerfile:1.7

# AssessIQ — assessiq-marketing container (public SEO site, Astro static).
#
# Standalone Astro project at apps/marketing/ — deliberately EXCLUDED from the
# pnpm workspace (see pnpm-workspace.yaml `- "!apps/marketing"`). It installs
# with its OWN lockfile via --ignore-workspace and never pulls the app's dep
# closure, so the heavy/unrelated Astro tree can't pollute the app lockfile or
# break the app's frozen install. Build context = repo root (compose
# build.context: ..); we COPY ONLY apps/marketing source files explicitly —
# never the whole tree, so a Windows-host node_modules can't leak into the
# Linux image (cf. assessiq-frontend's explicit-copy philosophy).
#
# Multi-stage: builder (astro build → /app/dist) → nginx:alpine static runtime.

ARG NODE_VERSION=22-alpine
ARG NGINX_VERSION=1.27-alpine

# ─── Stage 1: builder — astro build → /app/dist ──────────────────────────────
FROM node:${NODE_VERSION} AS builder
# Non-interactive corepack download (no TTY in CI/VPS build). pnpm version is
# pinned via the "packageManager" field in apps/marketing/package.json
# (pnpm@9.15.0 — matches the lockfile generator). node:22-alpine's corepack
# defaults to pnpm 11, whose minimumReleaseAge supply-chain policy rejects the
# freshest browserslist transitive deps and breaks a frozen install of a
# 9.x-generated lockfile; the pin keeps Docker on the same pnpm as the lockfile.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifest + lockfile first for layer caching; standalone install (ignore the
# parent workspace — there is none in this context anyway, but be explicit).
COPY apps/marketing/package.json apps/marketing/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store-mkt,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-workspace

# Source overlay AFTER install so a content edit doesn't bust the deps layer.
# Explicit copies only — NO node_modules, NO dist from the host.
COPY apps/marketing/astro.config.mjs apps/marketing/tailwind.config.mjs apps/marketing/tsconfig.json ./
COPY apps/marketing/src ./src
COPY apps/marketing/public ./public
RUN pnpm build

# ─── Stage 2: runtime — nginx:alpine static ──────────────────────────────────
FROM nginx:${NGINX_VERSION} AS runtime
# Replace the stock Welcome-page config with the AssessIQ static-site config.
RUN rm /etc/nginx/conf.d/default.conf
COPY infra/docker/assessiq-marketing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
# Inherit nginx:alpine's default ENTRYPOINT + CMD.
