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

ARG NODE_VERSION=22-alpine

# ─── Stage 1: deps — install pnpm workspace closure for @assessiq/api ────────
FROM node:${NODE_VERSION} AS deps

RUN corepack enable

WORKDIR /app

# Workspace metadata + every workspace member needed for the @assessiq/api
# transitive closure. .dockerignore strips test files, dev fixtures, and
# unrelated apps from the build context already.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY modules ./modules

# Frozen install of the api transitive closure. pnpm creates per-member
# node_modules selectively. The runtime stage copies the entire /app tree
# so every produced node_modules + every workspace source directory is
# carried forward without per-member enumeration.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '@assessiq/api...'

# ─── Stage 2: runtime — minimal layer with workspace symlink farm ────────────
FROM node:${NODE_VERSION} AS runtime

RUN corepack enable

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy the entire deps tree (workspace metadata + every node_modules pnpm
# created + every workspace source directory). Trailing /. on the source
# preserves directory contents.
COPY --from=deps /app/. ./

# Drop privileges. The `node` user is uid 1000 in node:22-alpine.
RUN chown -R node:node /app
USER node

WORKDIR /app/apps/api

EXPOSE 3000

# tsx is a devDep of apps/api; pnpm install pulled it into the symlink farm.
# Use `pnpm exec` so the workspace resolution path is honored.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
