# Session — 2026-05-01

**Headline:** Phase 0 G0.A shipped — pnpm monorepo scaffold, `modules/00-core` (config/logger/errors/request-context/ids/time) with 93/93 vitest passing, infra Compose (5-service, Caddy-aware) validating, RLS-policy linter with self-test, CI workflow with secrets/no-Anthropic/no-TODO/RLS gates. Bootstrap blocker for Phase 0 cleared; Windows 2 (02-tenancy) and 3 (17-ui-system) can now open in parallel.

**Commits:**

- HEAD on push — `feat(core): bootstrap repo + 00-core module` (run `git log` for the SHA)

**Tests:** 93/93 passing (5 vitest files: config 17, errors 49, request-context 9, ids 7, time 11). Typecheck green. ESLint green. RLS linter self-test green.

**Next:** Open Window 2 (G0.B / Session 2 — `02-tenancy`) and Window 3 (G0.B / Session 3 — `17-ui-system`) in parallel from a fresh `git pull`. Both depend on the scaffold + `00-core` shipped here. Window 2 is load-bearing per CLAUDE.md rule and will require `codex:rescue` adversarial sign-off before push.

**Open questions:**

- Should the CI's `pnpm install` move from `--no-frozen-lockfile` → `--frozen-lockfile` once `pnpm-lock.yaml` is committed and stable? (Recommended: yes, in G0.B-1's PR after the lockfile has cycled through one CI run.)
- Local Node is 20.11.1; `engines.node >= 22` produces a warning but no failure. Should we tighten with `pnpm config set engine-strict true` or wait until VPS deploys force the upgrade? (Recommended: leave for now; CI runs Node 22.)
- `docs/06-deployment.md` still has the docker-compose YAML inlined in the doc. Truth source is now `infra/docker-compose.yml`; future drift risk. Pivot to a pointer (rather than a copy) in G0.B-1's documentation pass.

---

## Agent utilization

- **Opus:** orchestrator throughout — Phase 0 warm-start reads, plan synthesis, three subagent prompts (root scaffold / 00-core / infra+CI), Phase 3 diff critique that surfaced 6 distinct issues, Phase 4 direct revisions (faster than spawning Sonnet for ≤ 50 lines across 7 cached files), Phase 2 deterministic gates, Phase 5 docker compose validate, Phase 6 docs + handoff.
- **Sonnet:** 3 parallel subagents in Phase 1.
  - **A (root scaffold):** `package.json` (pnpm@9.15.0, ESM, type:module, Node ≥22), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict + `verbatimModuleSyntax` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), `vitest.config.ts`, `eslint.config.js` flat config (no-console + no-restricted-imports against `@anthropic-ai/*` and the UI template), `.editorconfig`, `.env.example` with the explicit ANTHROPIC_API_KEY refusal block.
  - **B (00-core):** 6 source files + 5 vitest files + `package.json` + `tsconfig.json` + SKILL.md Status footer. Resolved logger ↔ request-context cycle one-way (logger imports `getRequestId` from request-context). Used Zod `.superRefine` for the cross-field `AI_PIPELINE_MODE` ↔ `ANTHROPIC_API_KEY` validation. Crockford `shortId` from `crypto.randomBytes(12)` masked to 5-bit values.
  - **C (infra + CI + tools):** `infra/docker-compose.yml` (5 services, `assessiq-net` bridge, only frontend publishes 9091, paths adjusted for new `infra/` location), `infra/postgres/init/.gitkeep`, `tools/lint-rls-policies.ts` (regex over `**/migrations/*.sql` with `--self-test` mode and tenants-table special case), `.github/workflows/ci.yml` (12 steps: install/typecheck/lint/test/RLS/RLS-self-test/secrets-scan/no-Anthropic/no-TODO).
- **Haiku:** n/a — no bulk read-only sweeps required this session; plan was pre-loaded from prior session and the diff fit in Opus's hot read cache.
- **codex:rescue:** n/a — Phase 0 G0.A is grading-free, no auth code, no RLS migrations. First mandatory invocation lands in Window 2 (02-tenancy RLS) before push.

---

## Phase 3 critique — issues found and fixed (Phase 4)

Six distinct issues caught by reading actual files (not subagent summaries) against the strict tsconfig and CI grep gates. All fixed by Opus directly:

1. **`errors.ts`** — `exactOptionalPropertyTypes: true` rejected `this.details = opts?.details` (rhs `undefined` not assignable to optional field). Re-declaring `readonly cause?: unknown` also conflicted with `Error.cause` under `noImplicitOverride: true`. Fix: pass `cause` to `super(message, { cause })`, drop the field re-declaration; conditionally assign `details` only when defined.
2. **`config.ts`** — eager `export const config = loadConfig()` evaluated at module load. Tests for any module that transitively imports `config` (via `logger.ts`) failed because vitest's `process.env` lacked the required vars. Fix: added `vitest.setup.ts` that injects deterministic env fixtures via `??=` before any test loads; wired into `vitest.config.ts` via `setupFiles`.
3. **`logger.ts`** — caught during typecheck rerun: `transport: buildTransport()` cannot accept `undefined` under `exactOptionalPropertyTypes`. Fix: spread `transport` conditionally (`...(transportOpt !== undefined ? { transport: transportOpt } : {})`).
4. **CI no-Anthropic grep** — original `\b(claude|anthropic|ANTHROPIC_API_KEY|claude-agent-sdk|@anthropic-ai)\b` regex matched the legitimate `AI_PIPELINE_MODE` enum values and the `ANTHROPIC_API_KEY` field name in `config.ts` (which exist precisely to enforce CLAUDE.md rule #1 at runtime). Fix: tightened to mirror precommit-gate.sh — package-import patterns + `spawn('claude'…)` + `sk-ant-*` literal — with the `modules/07-ai-grading/runtimes/anthropic-api.ts` allowlist.
5. **`tools/lint-rls-policies.ts`** — `import * as fs from "node:fs"` used only for the `Dirent` type → `verbatimModuleSyntax: true` violation; multiple `match[N]` accesses unsafe under `noUncheckedIndexedAccess`; `console.log` calls would fail eslint `no-console: error`. Fix: `import { type Dirent }`, non-null assertions on guaranteed-defined regex groups, `process.stdout.write` / `process.stderr.write` instead of console.
6. **`ids.ts`** — `CROCKFORD[bytes[i]! & 0x1f]` returns `string | undefined` under `noUncheckedIndexedAccess`. Fix: use `.charAt()` which always returns `string`.

A 7th issue surfaced post-fix during the `docker compose config` run — the env_file `../.env` did not exist. Fix: declared the env_file with `required: false` so validation works on a fresh clone; runtime Zod validation in `config.ts` is the safety net.

---

## Phase 2 deterministic gates — outcomes

| Gate | Result |
| --- | --- |
| `pnpm install` | ✅ 238 packages, no peer-warnings beyond engine-version (Node 20 vs ≥22 spec) |
| `pnpm -r typecheck` | ✅ green after Phase 4 fixes |
| `pnpm lint` | ✅ green after Phase 4 fixes |
| `pnpm test` | ✅ 93/93 vitest |
| `pnpm lint:rls` | ✅ 0 migrations scanned (none yet) |
| `pnpm tsx tools/lint-rls-policies.ts --self-test` | ✅ 3/3 fixtures (valid / invalid / tenants-special-case) |
| Secrets-scan over tracked files | ✅ clean (the gitignored `.env.local` is not in `git ls-files`) |
| No-Anthropic grep (tightened) | ✅ clean |
| No-TODO grep | ✅ clean |
| `docker compose -f infra/docker-compose.yml config` | ✅ exit 0 — 5 services with `assessiq-*` container names; only `assessiq-frontend` publishes 9091:80 |

---

## Files shipped (24)

**Root scaffold (7):**
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `vitest.setup.ts`, `eslint.config.js`, `.editorconfig`, `.env.example`

**Module `00-core` (14):**
- `modules/00-core/{package.json, tsconfig.json}`
- `modules/00-core/src/{config, logger, errors, request-context, ids, time, index}.ts`
- `modules/00-core/src/__tests__/{config, errors, request-context, ids, time}.test.ts`
- `modules/00-core/SKILL.md` (Status footer appended)

**Infra + tools + CI (4):**
- `infra/docker-compose.yml`, `infra/postgres/init/.gitkeep`
- `tools/lint-rls-policies.ts`
- `.github/workflows/ci.yml`

**Doc updates (1):**
- `docs/06-deployment.md` (compose-location + `env_file required:false` note appended above the inlined YAML block)

---

## Sharp edges for next session

1. **Compose lives at `infra/docker-compose.yml`** — not repo root. All compose commands need the explicit `-f infra/docker-compose.yml` flag, run from repo root or `/srv/assessiq/`.
2. **`env_file: required: false`** on api/worker means `docker compose config` won't catch a missing `.env`. Runtime Zod validation in `modules/00-core/src/config.ts` will throw clearly on first import — that's the safety net.
3. **Local Node is 20.11.1, spec is ≥22.** `engines.node` warning only; tests pass on 20. CI uses 22. If you start hitting Node-22-only API errors locally, install via `nvm`.
4. **Lockfile (`pnpm-lock.yaml`) is now committed.** CI uses `--no-frozen-lockfile` until lockfile-stability burns in over a session or two; tighten in G0.B-1.
5. **`vitest.setup.ts`** injects test fixtures for the Zod-validated env. Tests that need to drive `loadConfig` with custom inputs use the function form (`loadConfig({...})`) directly and ignore these defaults.
6. **`ANTHROPIC_API_KEY` cross-field validation** at the schema level is a defense-in-depth for CLAUDE.md rule #1 (in addition to the precommit hook + CI grep). If Phase 2 ever switches `AI_PIPELINE_MODE` to `anthropic-api`, that env var will be REQUIRED — and the absence of a budget switch would fail the schema.
