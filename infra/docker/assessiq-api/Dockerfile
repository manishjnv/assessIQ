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

# Workspace metadata first — keeps the dep layer cacheable across source-only
# changes. pnpm-workspace.yaml + lockfile + each member's package.json are the
# minimum surface needed for `pnpm install` to resolve the closure.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                 ./apps/api/
COPY modules/00-core/package.json          ./modules/00-core/
COPY modules/01-auth/package.json          ./modules/01-auth/
COPY modules/02-tenancy/package.json       ./modules/02-tenancy/
COPY modules/03-users/package.json         ./modules/03-users/
COPY modules/13-notifications/package.json ./modules/13-notifications/

# --frozen-lockfile fails if the lockfile is out of sync with package.json files.
# --filter @assessiq/api... resolves the API + its transitive workspace deps;
# anything outside that closure (apps/web, apps/storybook, AccessIQ_UI_Template,
# 04-question-bank scaffolding, 17-ui-system, etc.) is silently dropped.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '@assessiq/api...'

# ─── Stage 2: runtime — minimal layer with workspace symlink farm ────────────
FROM node:${NODE_VERSION} AS runtime

RUN corepack enable

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy the resolved pnpm symlink farm. Both the root node_modules (containing
# the .pnpm content-addressed store) AND each workspace member's node_modules
# (the actual symlinks the runtime resolves through) need to land — node_modules
# without .pnpm/ is broken under pnpm's hoisting strategy.
COPY --from=deps /app/node_modules                          ./node_modules
COPY --from=deps /app/apps/api/node_modules                 ./apps/api/node_modules
COPY --from=deps /app/modules/00-core/node_modules          ./modules/00-core/node_modules
COPY --from=deps /app/modules/01-auth/node_modules          ./modules/01-auth/node_modules
COPY --from=deps /app/modules/02-tenancy/node_modules       ./modules/02-tenancy/node_modules
COPY --from=deps /app/modules/03-users/node_modules         ./modules/03-users/node_modules
COPY --from=deps /app/modules/13-notifications/node_modules ./modules/13-notifications/node_modules

# Workspace metadata — needed at runtime so `pnpm exec` resolves binaries
# inside the symlink farm.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                 ./apps/api/
COPY modules/00-core/package.json          ./modules/00-core/
COPY modules/01-auth/package.json          ./modules/01-auth/
COPY modules/02-tenancy/package.json       ./modules/02-tenancy/
COPY modules/03-users/package.json         ./modules/03-users/
COPY modules/13-notifications/package.json ./modules/13-notifications/

# Source — apps/api + the workspace modules it imports from at runtime.
COPY apps/api/src                       ./apps/api/src
COPY apps/api/tsconfig.json             ./apps/api/
COPY modules/00-core/src                ./modules/00-core/src
COPY modules/00-core/tsconfig.json      ./modules/00-core/
COPY modules/01-auth/src                ./modules/01-auth/src
COPY modules/01-auth/migrations         ./modules/01-auth/migrations
COPY modules/01-auth/tsconfig.json      ./modules/01-auth/
COPY modules/02-tenancy/src             ./modules/02-tenancy/src
COPY modules/02-tenancy/migrations      ./modules/02-tenancy/migrations
COPY modules/02-tenancy/tsconfig.json   ./modules/02-tenancy/
COPY modules/03-users/src               ./modules/03-users/src
COPY modules/03-users/migrations        ./modules/03-users/migrations
COPY modules/03-users/tsconfig.json     ./modules/03-users/
COPY modules/13-notifications/src       ./modules/13-notifications/src
COPY modules/13-notifications/tsconfig.json ./modules/13-notifications/
COPY tsconfig.base.json                 ./

# Drop privileges. The `node` user is uid 1000 in node:22-alpine.
RUN chown -R node:node /app
USER node

WORKDIR /app/apps/api

EXPOSE 3000

# tsx is a devDep of apps/api; pnpm install pulled it into the symlink farm.
# Use `pnpm exec` so the workspace resolution path is honored.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
