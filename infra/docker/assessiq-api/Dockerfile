# syntax=docker/dockerfile:1.7

# AssessIQ — assessiq-api container.
# Phase 0 closure (Window 4 + route layer). Multi-stage pnpm-workspace install.
# Runtime executes TypeScript via tsx — no separate compile step (apps/api has
# no `build` script and is a thin Fastify wrapper around the workspace modules).
# Build context = repo root (set in compose `build.context: ..`).

ARG NODE_VERSION=22-alpine

# ─── Stage 1: deps — install pnpm workspace closure for @assessiq/api ────────
FROM node:${NODE_VERSION} AS deps

RUN corepack enable

WORKDIR /app

# Workspace metadata — pnpm needs the lockfile + every workspace member's
# package.json to resolve the install graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                 ./apps/api/
COPY modules/00-core/package.json          ./modules/00-core/
COPY modules/01-auth/package.json          ./modules/01-auth/
COPY modules/02-tenancy/package.json       ./modules/02-tenancy/
COPY modules/03-users/package.json         ./modules/03-users/
COPY modules/13-notifications/package.json ./modules/13-notifications/

# Frozen install of the api transitive closure. pnpm creates per-member
# node_modules selectively (depends on each member's declared deps). The
# runtime stage copies the entire /app tree so every produced node_modules
# (wherever pnpm puts them) lands without us having to enumerate.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '@assessiq/api...'

# ─── Stage 2: runtime — minimal layer with workspace symlink farm ────────────
FROM node:${NODE_VERSION} AS runtime

RUN corepack enable

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy the entire deps tree (workspace metadata + every node_modules pnpm
# created). Trailing /. on the source preserves directory contents.
COPY --from=deps /app/. ./

# Overlay source files from the build context. Doing this AFTER the deps
# COPY means a source-only edit doesn't bust the (much heavier) deps layer.
COPY apps/api/src                        ./apps/api/src
COPY apps/api/tsconfig.json              ./apps/api/
COPY modules/00-core/src                 ./modules/00-core/src
COPY modules/00-core/tsconfig.json       ./modules/00-core/
COPY modules/01-auth/src                 ./modules/01-auth/src
COPY modules/01-auth/migrations          ./modules/01-auth/migrations
COPY modules/01-auth/tsconfig.json       ./modules/01-auth/
COPY modules/02-tenancy/src              ./modules/02-tenancy/src
COPY modules/02-tenancy/migrations       ./modules/02-tenancy/migrations
COPY modules/02-tenancy/tsconfig.json    ./modules/02-tenancy/
COPY modules/03-users/src                ./modules/03-users/src
COPY modules/03-users/migrations         ./modules/03-users/migrations
COPY modules/03-users/tsconfig.json      ./modules/03-users/
COPY modules/13-notifications/src        ./modules/13-notifications/src
COPY modules/13-notifications/tsconfig.json ./modules/13-notifications/
COPY tsconfig.base.json                  ./

# Drop privileges. The `node` user is uid 1000 in node:22-alpine.
RUN chown -R node:node /app
USER node

WORKDIR /app/apps/api

EXPOSE 3000

# tsx is a devDep of apps/api; pnpm install pulled it into the symlink farm.
# Use `pnpm exec` so the workspace resolution path is honored.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
