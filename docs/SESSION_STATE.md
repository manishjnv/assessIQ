# Session — 2026-05-03 (brand kit shipped to production)

**Headline:** AssessIQ brand kit (mark, lockups, favicons, OG card, web manifest) shipped end-to-end — kit-defect fixes, PNG regen tooling, SPA wiring, and deployed to `https://assessiq.automateedge.cloud`. Definition of Done: commit / deploy / document / handoff all closed in this session.
**Commits:**
- `87b7064` — `feat(ui-system): add AssessIQ brand kit under AccessIQ_UI_Template/Logo/`
- `36d737c` — `chore(ui-system): regenerate brand PNGs + add brand:regen script`
- `0d78180` — `feat(web): wire AssessIQ brand kit into apps/web (favicon, OG, manifest)`
- *(this commit)* — `docs(branding): § 13.b for kit + nginx webmanifest MIME + handoff`

**Tests:** `pnpm --filter @assessiq/ui-system brand:regen` 13/13 PNGs regenerated cleanly; vite-dev curl-grid 10/10 paths 200 with correct content-types; prod curl-grid 9/9 paths 200 against `assessiq.automateedge.cloud`; visual verify via Read-as-image confirmed AssessIQ wordmark + canonical accent in regenerated PNGs.
**Next:** Resolve OG card copy + `assessiq.io` placeholder domain (still in `/brand/social/og-image.svg`) before any official social push. Otherwise the brand kit is fully live — Phase 2 G2.A Session 1.a (`modules/07-ai-grading` scaffold, separate WIP) remains the next coding task.
**Open questions:**

- OG card domain (`assessiq.io` placeholder vs the real `assessiq.automateedge.cloud`) — kept the placeholder pending user call; possibly a planned domain acquisition.
- OG card copy — `A calmer way to measure ability.` (also in webmanifest description) and `ASSESSMENT · MEASURED` eyebrow + `EST · 2026` footer were carried over from the original kit; not in any approved copy doc.
- Stacked lockup subtagline `ASSESSMENT · 2026` — same defer-to-decision; not in any doc.
- Folder rename `AccessIQ_UI_Template/` → `AssessIQ_UI_Template/` — left unchanged to match the precedent and avoid coordinated rename of every inbound path; the *contents* are now correctly AssessIQ-branded.

---

## What shipped

### Slice 1 — kit defect fixes (commit `87b7064`)

The brand kit (28 files) was originally authored at `modules/17-ui-system/AccessIQ_Branding_Logo_Template/` and moved mid-session by the user to `modules/17-ui-system/AccessIQ_UI_Template/Logo/` so design system and brand identity share one source of truth.

Three classes of defect fixed in-place vs. the as-shipped template:

1. **Wordmark typo** — `AccessIQ` → `AssessIQ` in every SVG `<title>`/`<text>`/`aria-label`, the README, the manifest's `name`/`short_name`, and the visual `brand-guidelines.html`. Per `docs/10-branding-guideline.md:5` the product is unambiguously *AssessIQ*; the parent folder name keeps the typo as a precedent (matches existing `AccessIQ_UI_Template/`), but the asset content does not.
2. **Mark colour** — `#1a73e8` (Google blue) → `#3177dc`, the canonical accent computed from `oklch(0.58 0.17 258)` per `modules/17-ui-system/src/styles/tokens.css:28`. Dark variant `#7ab1f5` → `#5b9eff` (`oklch(0.70 0.16 258)`); a stray hover `#155bb5` in `brand-guidelines.html` → `#0462d3` (`oklch(0.52 0.19 258)`). Computed via inline Node script using Björn Ottosson's OKLCH→sRGB matrices.
3. **File renames** — `accessiq-{mark,wordmark,horizontal,stacked,...}.{svg,png}` → `assessiq-*.*` (11 files). Unprefixed favicons (`favicon-16.png`, `apple-touch-icon-180.png`, `app-icon-192.png`, etc.) kept their standard names.

Also folded in: `modules/17-ui-system/AccessIQ_UI_Template/CLAUDE.md` updated so its file/folder conventions tree lists the new `Logo/` subfolder — future sessions discover the kit at warm-start.

### Slice 2 — PNG regen tooling (commit `36d737c`)

After fix slice 1, the renamed PNGs still showed the OLD pixel content (`AccessIQ` wordmark + `#1a73e8`). Needed regeneration from updated SVGs.

- Added `@resvg/resvg-js@^2.6.2` as devDep on `@assessiq/ui-system` — pure-WASM, ~5MB, no native binary, no Chromium overhead.
- Wrote [`modules/17-ui-system/tools/regenerate-brand-pngs.ts`](../modules/17-ui-system/tools/regenerate-brand-pngs.ts) — declarative job manifest of 13 SVG → PNG mappings with target sizes (favicons 16/32/48, apple-touch 180, app-icons 192/512/1024 + dark, og-image 1200×630, lockups at canonical sizes).
- Wired as `pnpm --filter @assessiq/ui-system brand:regen`.
- Visual verify (Read-as-image on regenerated PNGs): confirmed `AssessIQ` wordmark + `#3177dc` accent landed cleanly. Newsreader serif rendered correctly via system font fallback inside resvg.

### Slice 3 — SPA wiring (commit `0d78180`)

- [`apps/web/scripts/copy-brand-assets.mjs`](../apps/web/scripts/copy-brand-assets.mjs) — mirror script copies `Logo/{favicon,logo,social}/` (25 files) into `apps/web/public/brand/`.
- [`apps/web/package.json`](../apps/web/package.json) — `predev` and `prebuild` hooks invoke the mirror script, so any `pnpm dev` or `pnpm build` re-mirrors automatically.
- [`apps/web/index.html`](../apps/web/index.html) — added 13 head tags: favicon set (svg + 16/32 png + apple-touch), `<link rel="manifest">`, `theme-color`, `description`, `og:title|description|image|type`, `twitter:card|image`.
- [`.gitignore`](../.gitignore) — `apps/web/public/brand/` excluded; source-of-truth is always the kit.
- Verified end-to-end via `vite dev` curl-grid: 10/10 paths return 200 with correct content-types; index.html serves all 13 new head tags; manifest renders cleanly with name/short_name/description/theme_color matching the brand contract.

**Logo.tsx — Path 1 decision.** [`modules/17-ui-system/src/components/Logo.tsx`](../modules/17-ui-system/src/components/Logo.tsx) left untouched. The in-product mark stays the existing CSS-driven `aiq-mark` (calmer dot+halo per branding-guideline § 6). The kit's SVGs (richer dot+two-rings) are for *external* surfaces — favicons, OG card, decks, emails. Two variants intentionally honor "in-product is calmer than the brand-on-a-deck."

### Slice 4 — production deploy

- VPS enumeration first per `CLAUDE.md` rule #8: `docker ps` confirmed 5 namespaced `assessiq-*` containers among 19 total; the other 14 (roadmap, accessbridge, ti-platform) untouched throughout.
- Source pushed to `/srv/assessiq` via `git archive HEAD <paths> | ssh assessiq-vps tar -x` (VPS isn't a git repo — uses tar archive deploy pattern per the May 2 RCA).
- `docker compose -f /srv/assessiq/infra/docker-compose.yml build assessiq-frontend` rebuilt the image from `e851db5c5678` → `4424a4350f2d`. Build log shows the prebuild script ran cleanly inside Docker (12 favicon + 11 logo + 2 social mirrored), and `vite build` produced 320 modules with no errors.
- `docker compose up -d assessiq-frontend` recreated the container only — no other `assessiq-*` containers touched.
- Prod curl-grid (`https://assessiq.automateedge.cloud`): 9/9 brand assets return 200, index.html ships all 13 head tags, manifest content matches local exactly.

### Slice 5 — nginx webmanifest MIME fix (this commit)

The prod curl-grid surfaced one nit: `site.webmanifest` was served as `application/octet-stream` because nginx's default `mime.types` doesn't map `.webmanifest`. Browsers tolerate this via `<link rel="manifest">` content sniffing, but it's a correctness gap.

[`infra/docker/assessiq-frontend/nginx.conf`](../infra/docker/assessiq-frontend/nginx.conf) now has a dedicated `location ~ \.webmanifest$` block setting `default_type application/manifest+json`, with 1-day cache (the manifest URL is unhashed, so longer cache delays icon updates). To be redeployed alongside this docs commit.

### Documentation updates

- **`docs/10-branding-guideline.md`** — new § 13.b "Brand kit (logo, favicon, OG card, web manifest)" covering folder location, wordmark/colour/naming rules, the two regen+mirror workflows, production wiring, the Path 1 decision, and the still-pending OG/domain/subtagline questions. Comprehensive enough that a future session can resume the kit work without reading any diff.
- **This SESSION_STATE entry** — full session narrative + agent footer per project rule.

### Out of this session's scope (explicit)

- Phase 2 G2.A Session 1.a (`modules/07-ai-grading` scaffold) — remains untracked WIP; the parallel session's `dee4c86` correctly excluded it too.
- Pre-existing working-tree changes to `modules/00-core/src/config.ts`, `tools/lint-rls-policies.ts`, `pnpm-lock.yaml` (07-ai-grading importer block), and the `lint:ambient-ai` scripts in root `package.json` — all Session 1.a glue, surgically untouched throughout this session via `git stash` during the @resvg install + targeted-path `git add` for every commit.

### Adversarial review

Skipped — UI assets, HTML, JSON manifest, CSS-class component, nginx MIME mapping, asset-mirror script. None touch security/auth/classifier surface or any load-bearing path under `modules/{01-auth,02-tenancy,07-ai-grading,14-audit-log}` or core deploy infra (Caddyfile, shared mounts, certbot). Per CLAUDE.md "scale rigor to change magnitude" — full rescue ceremony not warranted.

---

## Agent utilization
- Opus: full session end-to-end — kit-defect review and triage, OKLCH→sRGB hex computation via inline Node, all SVG/manifest/README/HTML edits via parallel `Edit` calls, regen tooling design, asset-mirror script, nginx MIME fix, VPS enumeration + tar-archive deploy + curl-grid verify, branding-guideline § 13.b authoring.
- Sonnet: n/a — work fragmented into small edits (≤30 lines each) with files already in Opus read cache; subagent cold-start (~20-30s) would have outweighed token savings on every slice.
- Haiku: n/a — bulk verification was inline curl-grid (10 paths dev + 9 paths prod, single bash call each); too small to warrant a Haiku subagent dispatch.
- codex:rescue: n/a — no security/auth/classifier surface; no load-bearing-path writes; kit + wiring is pure visual asset + static HTML/manifest. CLAUDE.md "scale rigor to change magnitude" applies.

---

# Session — 2026-05-03 (RCA-driven tooling hardening)

**Headline:** Edge-routing CI lint + shared-mount sed PreToolUse hook shipped — converts five "manual discipline" RCAs from the past 4 days into harness-enforced gates. No module code, no shared-VPS deploy.
**Commits:** *(commit-pending — orchestrator to commit at session exit)* — `chore(tooling): edge-routing lint + shared-mount sed hook + RCA prevention`
**Tests:** typecheck pass, edge-routing self-test 7/7 pass, edge-routing repo scan green (22 files / 70 mounts), no-sed-shared-mount hook 8/8 synthetic tests pass, synthetic violation test exits 1 as required.
**Next:** Phase 2 G2.A Session 1.a (`modules/07-ai-grading` scaffold) is the next coding task — its working tree is already pre-staged from an earlier session, awaiting its own commit + `codex:rescue` adversarial pass per the load-bearing-paths rule.
**Open questions:**

- The Deliverable 3 typecheck failure documented in the prior session-state's "Open questions" line 59 (`question_id: 'string | undefined' vs 'string | null'`) does NOT reproduce against the current working tree — `pnpm -r typecheck` reports clean across all 15 workspaces. The seam at `modules/11-candidate-ui/src/types.ts:121` already has `question_id?: string | null` (optional + nullable) and `useIntegrityHooks.ts:60` normalizes via `?? null` at the producer boundary. Whoever fixed it didn't update SESSION_STATE.md. This handoff drops the stale claim — Deliverable 3 is a no-op.
- The `permissions.defaultMode: bypassPermissions` removal in `.claude/settings.json` (pre-existing in the working tree) is intentional cleanup per memory observation 436 (the value lives in gitignored `.claude/settings.local.json` now). Included in this session's commit as tangentially-related tooling cleanup.

---

## What shipped

### Deliverable 1 — `tools/lint-edge-routing.ts` (new, 671 lines)

CI lint that prevents the third edge-routing fallthrough incident. Walks `apps/api/src/server.ts` plus all module-side route registration files for `app.<verb>("/<path>", ...)` and `app.route({ method, url })` mounts. Reads the canonical `@api path ...` line from `docs/06-deployment.md` § "Current live state" — single source of truth, no hardcoded duplicate list. Coverage rule: a non-`/api/*` mount passes if either (a) Caddy path-match (`/foo/*`, `/foo*`, exact `/foo`) covers it, or (b) any matcher entry shares its first path segment (so `GET /take/:token` is OK when `/take/start` is in the matcher — codified intent for split SPA/API behavior). Self-test ships 7 fixtures including a regression guard for the 2026-05-03 `/take/*`-missing case; production mode reads from disk.

**Wiring:**
- `.github/workflows/ci.yml` step 9c — self-test + repo scan, both required-pass.
- `package.json` — `lint:edge-routing` and `lint:edge-routing:self-test` scripts.

**Verified:**
- `pnpm tsx tools/lint-edge-routing.ts --self-test` → exit 0, all 7 fixtures pass.
- `pnpm tsx tools/lint-edge-routing.ts` → exit 0 on current main (22 files scanned, 70 route mounts checked, canonical matcher: `@api path /api/* /embed* /help/* /take/start`).
- Synthetic violation test (temp-add `app.get("/foo/bar", ...)` to server.ts) → lint output `mount "/foo/bar" — not covered by Caddy @api matcher`, exit 1.

**Prevents:** 2026-05-02 `/help/*` fallthrough, 2026-05-03 `/take/*` fallthrough RCA pattern class (third incident would be process failure).

### Deliverable 2 — `.claude/hooks/no-sed-shared-mount.sh` (new)

Bash PreToolUse hook on the Bash tool. Reads tool-input JSON via stdin (jq with sed fallback). Two-phase AND check before blocking:

1. **Editor pattern** — `\bsed[[:space:]]+(-[a-zA-Z]*[[:space:]]+)*-i([^a-zA-Z]|$)`, plus `awk -i inplace`, `perl -pi`, `ruby -pi`, `gawk -i inplace`, `python -m fileinput -i`. The trailing `([^a-zA-Z]|$)` terminator on the `-i` flag prevents over-firing on hypothetical combined flags like `sed -in...`.
2. **Path target** — `/opt/ti-platform/`, `/etc/`, `/srv/` (excluding `/srv/assessiq/`), `/var/log/` (excluding `/var/log/assessiq/`), `/var/backups/` (excluding `/var/backups/assessiq/`). Trailing slash is mandatory so `/opt/ti-platform-foo` doesn't false-match.

Exit 2 with stderr citing all three RCA dates and showing the truncate-write recovery procedure. Override: `ALLOW_SHARED_MOUNT_SED=1 <command>` prefix passes through (escape hatch for genuinely necessary in-place edits).

**Wiring:** `.claude/settings.json` PreToolUse Bash hooks array, ordered AFTER `precommit-gate.sh` (cheaper/more frequent checks first, targeted VPS guard second).

**Verified — 8/8 synthetic tests:**

| # | Command | Expected | Actual |
|---|---|---|---|
| 1 | `sed -i s/foo/bar/ /opt/ti-platform/caddy/Caddyfile` | BLOCK (2) | 2 ✓ |
| 2 | `sed -i s/foo/bar/ /srv/assessiq/.env` | ALLOW (0) | 0 ✓ |
| 3 | `sed s/foo/bar/ /opt/ti-platform/caddy/Caddyfile > /tmp/new` | ALLOW (0) | 0 ✓ |
| 4 | `perl -pi -e s/foo/bar/g /etc/nginx/nginx.conf` | BLOCK (2) | 2 ✓ |
| 5 | `ALLOW_SHARED_MOUNT_SED=1 sed -i ... /opt/ti-platform/...` | ALLOW (0) | 0 ✓ |
| 6 | `git status` | ALLOW (0) | 0 ✓ |
| 7 | `awk -i inplace { print } /var/log/syslog` | BLOCK (2) | 2 ✓ |
| 8 | `awk -i inplace { print } /var/log/assessiq/app.log` | ALLOW (0) | 0 ✓ |

**Prevents:** 2026-04-30 + 2026-05-02 + 2026-05-03 inode-trap RCA pattern class. Three incidents in 4 days; manual discipline gate has demonstrably failed.

### Deliverable 3 — pre-existing 11-candidate-ui typecheck failure

**Status: no-op.** The failure documented in the prior session-state handoff does not reproduce against the current working tree. Investigation: `modules/11-candidate-ui/src/types.ts:121` defines `CandidateEventInput.question_id?: string | null` (optional + nullable). `modules/11-candidate-ui/src/hooks/useIntegrityHooks.ts:33-63` accepts `string | null | undefined` at the `emit()` boundary and normalizes via `?? null` at the wire-encoding step. The seam is already aligned end-to-end with the `string | null` invariant; there is no `string | undefined` leakage to fix. `pnpm -r typecheck` reports clean across all 15 workspaces, including `apps/web` and `modules/11-candidate-ui`.

The prior session-state's claim is removed from this handoff's "Open questions."

### Documentation updates

- **`docs/06-deployment.md` § "Current live state"** — canonical Caddyfile snippet updated to include `/take/start` in the `@api path` matcher (the live VPS state per the 2026-05-03 inode-trap recovery; the doc was previously stale). Section heading bumped to Phase 1 G1.D, explanation paragraph added describing the deliberate `/take/start` (API) vs `/take/:token` (SPA) split. Lint reads from this section, so doc accuracy is now load-bearing.
- **`docs/RCA_LOG.md`** — prepended a "## 2026-05-03 — preventive guardrails added" entry covering both deliverables. Format follows CLAUDE.md rule #5: what / why now / considered-and-rejected (six options, including warning-only lint, hardcoded matcher list, log-only hook, AST parsing, precommit-only enforcement, and single-file path scoping) / NOT included (docker-closure lint, vitest-toSatisfy ESLint rule, ambient-AI lint changes) / downstream impact (future SKILL.md reminders can drop, doc snippet now load-bearing for lint).

### Out of this session's scope (explicit)

- `modules/07-ai-grading/` (Session 1.a) — scaffold present in working tree as untracked files. Awaits its own commit + `codex:rescue` adversarial pass.
- The pre-existing working-tree changes to `modules/00-core/src/config.ts` (open-weights enum), `tools/lint-rls-policies.ts` (tenant_grading_budgets PK=tenant_id special-case), `pnpm-lock.yaml`, and the `lint:ambient-ai` scripts in `package.json` / step 9a in `.github/workflows/ci.yml` are all Session 1.a supporting glue. Surgically NOT staged for this session's commit per the user's brief "Out of scope: modules/07-ai-grading/."

### Adversarial review

Skipped per the user's brief — pure tooling, no security/auth/classifier surface. Both deliverables are dev/CI guards that don't touch any load-bearing path under `modules/01-auth/`, `modules/02-tenancy/`, `modules/07-ai-grading/`, or `modules/14-audit-log/`. Both are also static — neither calls `claude`, `anthropic`, or any external service. Skip decision logged here per CLAUDE.md rule #9 doc-detail requirement.

---

## Agent utilization

- **Opus 4.7 (1M)**: Phase 0 warm-start parallel reads (PROJECT_BRAIN + SESSION_STATE + RCA_LOG + 06-deployment + lint-rls-policies + precommit-gate); Phase 3 diff critique (no bounces); cross-module type-seam audit for Deliverable 3 (verified seam already aligned, dropped phantom-fix temptation); orchestration of partial-stage-via-back-edit to surgically exclude pre-existing Session 1.a hunks from the commit; same-PR doc detail in RCA_LOG.md (~95 lines covering five rejected alternatives) + SESSION_STATE.md overwrite.
- **Sonnet**: 2 parallel Phase 1 calls — Sonnet A (`tools/lint-edge-routing.ts` + `docs/06-deployment.md` matcher update + ci.yml + package.json wiring; 671 lines + 7-fixture self-test; reported all gates green) and Sonnet B (`.claude/hooks/no-sed-shared-mount.sh` + `.claude/settings.json` hook wiring; 8 synthetic tests all pass; reported actual exit codes).
- **Haiku**: n/a — no bulk live-prod sweeps in scope (no deploy this session).
- **codex:rescue**: n/a — judgment-skip per user's brief, pure dev tooling with no security/auth/classifier surface (CLAUDE.md rule allows scaling rigor to change magnitude; skip logged here per rule #9).
