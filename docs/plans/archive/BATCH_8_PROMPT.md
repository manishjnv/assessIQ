> **Status note (2026-10-02, added by the parallel session that shipped `c89b326..43e4ebf`, also labelled "batch 7"):**
> **N7 is DONE** — Actions v7/v6, minor/patch group, jose 6 (accepted by adversarial review), React 19.3, Vite 8 + vitest 4 for apps/web (build.target pinned to chrome87 floor). Left over as **N10**: argon2 0.45, Storybook 10, astro-og-canvas 0.13, canvaskit-wasm 0.42. **N9 is DONE** (`635f3fb`). Skip both. To avoid confusion, name this work **batch 8**. See `docs/SESSION_STATE.md` entry (k).

# Batch 7 — Claude-only tasks (10 tasks, no owner input needed)

You are starting a fresh session on AssessIQ (repo `E:\code\AssessIQ`, prod `assessiq.in`, VPS alias `assessiq-vps`). Goal: ship the open tasks below that need NO owner input, each committed → deployed → documented → handed off (CLAUDE.md rule 9). Work autonomously; do not stop to ask unless a task hits a STOP condition listed below.

## 0. Warm start (one parallel message)

Read: `CLAUDE.md`, `PROJECT_BRAIN.md`, `docs/SESSION_STATE.md` (top 2 entries), `docs/RCA_LOG.md` (last 10 entries), `docs/ROADMAP.md` (rows D4, E8, E9, E10, F1, F3, F4, F5, N7, SP7 + the "Done 2026-10-02" sections), `docs/06-deployment.md` § steady-state deploy + § Batch 5 deploy.
Then run `git log --oneline -15` and `git status`. **A parallel session may have already done some of these** (e.g. N9 landed in `635f3fb` before this prompt was written). Drop any task already done; list what remains before starting.

## 1. Hard rules (from memory + overlay — do not skip)

- **Parallel sessions share one working tree.** Run `git rev-parse --abbrev-ref HEAD` before every commit; must be `main`. If files vanish, check `git stash list` (auto-stash hook) before anything else.
- **`docs/` is gitignored.** Stage docs with `git add -f docs/...` in a command of its own, never chained with `&&` to other adds/commits.
- **Push privacy:** every commit authored + committed as `Manish Kumar <257227540+manishjnv@users.noreply.github.com>` (env-var + `--author` pattern in global CLAUDE.md). Run `git push` as its own command (push-gate hook misses pushes after a quoted env var).
- **Repo is PUBLIC.** Never commit question/answer content, secrets, or prompt skills. Exam content lives only in `docs/exam-content/`.
- **VPS is shared — additive deploys only.** `ssh assessiq-vps 'cd /srv/assessiq && git pull'`, then `docker compose -f infra/docker-compose.yml build <svc>` and `up -d --no-deps --force-recreate <svc>`. Enumerate before touching anything; never prune, never touch non-`assessiq-*` containers/units/configs.
- **Load-bearing paths** (`modules/00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/`, Dockerfiles, compose, Caddy/nginx): Sonnet may write, Opus reviews the diff line by line; security-adjacent changes need `codex:rescue` before push (fallback: Sonnet takeover per global playbook). No ambient AI calls; no Agent SDK outside `runtimes/anthropic-api.ts`.
- **Multi-tenancy bounce rules:** every new domain table has `tenant_id` + RLS; every endpoint has tenant middleware; no `if (domain === "soc")`; band scoring stays 0/25/50/75/100.
- **Routing:** announce tier + reason before each delegation. Sonnet for implementation, Haiku for verify sweeps/greps, Opus for review and security judgment. Max ~6 parallel Sonnet agents.
- **Same-PR docs:** schema → `docs/02-data-model.md`, API → `docs/03-api-contract.md`, new UI → `help_id` + `modules/16-help-system` seed, bug fix → `docs/RCA_LOG.md`.
- Pre-commit gates on every diff: tests for touched modules, `TODO|FIXME|XXX` grep (CI no-TODO gate), secrets scan patterns from global CLAUDE.md.

## 2. Tasks

### Wave A — parallel, low risk (fire together)

**F1 IndexNow** (`apps/marketing`). Generate a 32-hex key, add `apps/marketing/public/<key>.txt` containing the key. Add a small script (e.g. `apps/marketing/scripts/indexnow-submit.mjs`, no new deps, stdlib `fetch`) that reads the built sitemap and POSTs all URLs to `https://api.indexnow.org/indexnow` (host `assessiq.in`, `keyLocation` = the public file). Add the ping as a post-deploy step in `docs/06-deployment.md`. After deploy, run it once for all ~54 URLs and record the HTTP status. Key is public by design (not a secret).
Accept: `curl https://assessiq.in/<key>.txt` returns the key; submit returns 200/202.

**F4 page dates** (`apps/marketing/src/pages/**`). 39 of 56 content pages lack `datePublished`/`dateModified`. Add them to each page's JSON-LD (Article/WebPage) and visible "Updated" where the layout already supports it. Source dates from `git log --follow --format=%aI` (first commit = published, last = modified) — no invented dates.
Accept: Haiku sweep — every content page's built HTML has both fields; JSON-LD parses.

**F5 sitemap lastmod** (`apps/marketing/astro.config.mjs`). Replace build-time/blank `lastmod` with each page's real last-modified date (same git-derived source as F4; share one helper, don't write it twice).
Accept: built `sitemap-*.xml` has per-URL `lastmod` values that differ across pages and match git.

**F3 Core Web Vitals.** Measure mobile + desktop for `/`, `/pricing`, `/try`, one blog page via PageSpeed Insights API (no key needed for low volume) — record LCP/INP/CLS/TTFB before. Fix the Google Fonts CSS `@import` LCP risk: switch to `<link rel="preconnect">` + `<link rel="stylesheet">` with `display=swap` in `BaseLayout.astro` (or self-host via an already-installed package if one exists — no new deps). Re-measure after deploy.
Accept: before/after table in `docs/11-observability.md` (or the SEO plan doc); no `@import` of fonts left in CSS.

**E10 stale docs.** `docs/plans/archive/grading-completion-fix-plan.md` → mark DONE (fixed `defb9f9`, live). `docs/01-architecture-overview.md` → replace PM2/direct-API description with the real Docker Compose + Caddy/Cloudflare topology (verify against `infra/docker-compose.yml`, don't guess). Fix tenant-lifecycle and question-difficulty doc headers to current status. Also mark N9 (and anything else verified done) as done in `PENDING_TASKS`.
Accept: every claim in the edited sections cites a file or commit that exists.

**D4 onboarding runbook.** New `docs/runbooks/customer-onboarding.md`: super-admin step-by-step to provision a company — create tenant (fresh MFA), domain/pack entitlements, invite company admin, release mode (manual default), integrity settings, CSV import format (roll/branch), sending invites, evaluation queue → release, results CSV, backups, erasure requests. Base every step on the actual UI routes/endpoints (grep `apps/api/src/routes`, `modules/10-admin-dashboard/src/pages`). Plain language — the owner will follow it.
Accept: each step names the screen/route that exists today.

### Wave B — moderate risk (after Wave A is committed)

**N7 Dependabot majors** (PRs #6-#14). Use `gh pr list` / `gh pr view`. Per PR: read the changelog breaking changes, then either merge (build + full tests green) or close with a one-line reason and a follow-up note. Do GitHub Actions bumps and react together only if tests pass. **vite 8:** build web + marketing, run e2e-free test suites. **jose 6 is auth (`modules/01-auth`)** → Opus diff review + `codex:rescue` before push; if JWT/JWK APIs changed, adapt code and add a test proving tokens minted before the bump still verify after. If any major needs non-trivial rewrites, defer it with a written reason rather than forcing it.
Accept: no open Dependabot major PRs without a recorded decision; CI green; `pnpm audit --prod` still 0 high.

**E8 ops leftovers** (load-bearing: infra). See `docs/design/2026-05-15-operational-maturity-audit.md`.
1. *Caddyfile in repo:* copy the live AssessIQ Caddy site block into `infra/caddy/` (read it over SSH, read-only). Only the AssessIQ block — never other tenants' blocks. Strip nothing secret into git (check for tokens/origin-verify secrets first; template them as env refs if present).
2. *Staging + rollback procedure:* write it in `docs/06-deployment.md` — rollback = `git checkout <prev-sha>` on VPS + rebuild the service + migration notes (forward-only migrations: document what to do). Staging = a documented compose-project-name approach on the same VPS only if it is purely additive; otherwise document it as not built and why.
3. *MASTER_KEY rotation:* write the procedure + a dry-run-capable script (re-encrypt with new key, dual-key read window). **STOP before rotating the live key** — rotation on prod needs owner go-ahead; deliver it ready-to-run.
Codex gate on any infra/crypto code.
Accept: Caddy block in repo matches live (diff = 0 apart from templated secrets); script dry-run passes against a test DB.

**SP7 more auto-graded types** (load-bearing: 06/07/09 — Opus review + codex). Numeric and multi-select are DONE (batch 3). Remaining:
- *Structured log + scenario items:* add deterministic scoring only where the item has an exact answer key (e.g. pick-the-log-line, ordered steps, field extraction with exact match). Reuse the batch-3 deterministic path (`grader='deterministic'`, points frozen in `attempt_questions.points`); free-text parts stay on the AI path. New sub-types need: question-bank schema validation, authoring UI fields, candidate renderer, admin renderer (never raw JSON — typed per-type renderers, answer key audience-gated), help ids, docs 02/03/05.
- *KQL by running the query (X4):* **design only, do not build.** It needs a query engine/sandbox. Write a short design note in `docs/design/` (options, isolation, cost) and STOP.
Accept: DB integration tests prove a mixed attempt scores deterministic parts without AI and still grades the rest; candidate never receives the answer key (add a test).

### Wave C — only if time remains

**E9 god files.** Pure mechanical moves, no behavior change, one file per commit: split `modules/10-admin-dashboard/src/pages/platform.tsx` (2,981 lines) into per-tab components; then replace the 36 `as any` in `modules/18-certification` with real types. Leave `04-question-bank/src/service.ts` and `apps/api/src/routes/admin-super.ts` for later unless a Wave B task already touched them. Tests + typecheck green before and after; diff must be moves/types only.

## 3. STOP conditions (ask the owner, don't push through)

- Any step would touch non-AssessIQ VPS resources or require a destructive op.
- Rotating the live MASTER_KEY.
- A Dependabot major needs an architectural rewrite.
- A load-bearing diff fails codex/Sonnet-takeover review twice (abort criterion: approach wrong vs execution wrong).
- Anything needing Max OAuth login, legal text, pricing or KYC.

## 4. Finish (Definition of Done)

Per wave: commit (conventional message, module refs, noreply author) → push → deploy (only services touched; marketing rebuild for F-tasks) → Haiku post-deploy sweep (health, headers, IndexNow file, sitemap lastmod, a JSON-LD sample, CWV) → docs.
End of session: create `docs/plans/archive/PILOT_BATCH_7.md` (what/why/rejected/excluded/impact per task), update `PENDING_TASKS` (mark done with SHAs), append RCA entries for any bug fixed, prepend `docs/SESSION_STATE.md` with the 30-line header + 5-line agent-utilization footer + routing telemetry lines, update the MEMORY.md index line for the pilot. Reply to the owner with the plain-English summary, a task table (task / status / SHA / lines changed), next steps, and the token line.
