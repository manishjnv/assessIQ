# syntax=docker/dockerfile:1.7

# AssessIQ — assessiq-api container.
# Multi-stage pnpm-workspace install. Runtime executes TypeScript via tsx —
# no separate compile step (apps/api has no `build` script and is a thin
# Fastify wrapper around the workspace modules).
#
# Build context = repo root (set in compose `build.context: ..`). The repo
# root .dockerignore excludes node_modules, .git, .env*, secrets/, **/__tests__,
# tests, apps/web, apps/storybook, modules/17-ui-system, docs/, *.md so the
# workspace COPYs below stay lean.
#
# Why the deps stage copies whole apps/api + modules trees instead of just
# package.json files: previous Dockerfiles enumerated `COPY modules/<name>/
# package.json` per module, which silently broke every time a new workspace
# member was added (pnpm install --frozen-lockfile failed with
# ERR_PNPM_WORKSPACE_PKG_NOT_FOUND when the new member wasn't enumerated).
# Copying the whole tree picks up any new module automatically. The trade-off
# is that source-only edits invalidate the deps layer cache — acceptable
# given the rebuild cadence.

# node:22-slim (Debian bookworm-slim) is required instead of Alpine because
# the `claude` CLI binary installed on the host VPS is a glibc ELF executable
# (built against GNU libc 2.17+). Alpine uses musl libc; glibc binaries do not
# run on musl without a compatibility shim. The Debian slim base ships glibc
# and is the standard choice when the container needs to exec host-installed
# glibc binaries via a bind-mount. Image size delta: ~40MB vs Alpine.
ARG NODE_VERSION=22-slim

# ─── Stage 0: manifests — extract only package.json files (auto-picks up new members) ─
# Rebuilds on any source edit, but is cheap; its OUTPUT (the manifests) is
# content-hashed, so the deps stage below stays CACHED unless a manifest changes.
FROM node:${NODE_VERSION} AS manifests
WORKDIR /src
COPY apps/api ./apps/api
COPY modules ./modules
COPY packages/question-types ./packages/question-types
RUN mkdir /out && find apps modules packages -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out \;

# ─── Stage 1: deps — install pnpm workspace closure for @assessiq/api ────────
FROM node:${NODE_VERSION} AS deps

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=manifests /out/ ./

# Frozen install of the api transitive closure. Depends only on manifests +
# lockfile, so source-only edits no longer re-run it.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '@assessiq/api...'

# Source overlay (after install). Merges into the pnpm-created node_modules.
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY modules ./modules
COPY packages/question-types ./packages/question-types

# ─── Stage 2: runtime — minimal layer with workspace symlink farm ────────────
FROM node:${NODE_VERSION} AS runtime

RUN corepack enable

# ca-certificates: claude CLI HTTPS + general TLS.
# chromium + fonts-liberation: certificate PDF rendering (modules/18-certification
#   launches headless Chromium via playwright-core at /usr/bin/chromium — the
#   Debian package installs exactly there, matching render.ts's default
#   executablePath). Without this the PDF endpoint 500s ("executable doesn't
#   exist at /usr/bin/chromium"). fonts-liberation gives metric-compatible
#   Arial/Times so the template's Helvetica/Georgia fallbacks render cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node

WORKDIR /app

# Copy the entire deps tree (workspace metadata + every node_modules pnpm
# created + every workspace source directory). Trailing /. on the source
# preserves directory contents.
COPY --chown=node:node --from=deps /app/. ./

# Was `chown -R node:node /app`: a full duplicate layer of the tree (~7 min).
# COPY --chown gives the same ownership; only the /app directory itself needs it.
RUN chown node:node /app

# Runs as root: container needs to read /root/.claude/.credentials.json
# (mode 600, root-owned) for claude CLI auth. Per 2026-05-09 RCA,
# whole-dir mount + USER root replaces the per-file mount pattern
# that broke on every claude version bump. Single-tenant admin container;
# node-user isolation adds little real security here.
USER root

WORKDIR /app/apps/api

EXPOSE 3000

# tsx is a devDep of apps/api; pnpm install pulled it into the symlink farm.
# Use `pnpm exec` so the workspace resolution path is honored.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
