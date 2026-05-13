# Session — 2026-05-13 (Phase 5 Session 8 — candidate passwordless magic-link login, 30-day session)

**Headline:** Option A (magic-link candidate auth) shipped end-to-end. Candidates can sign in at `/candidate/login` with an email; system emails a 15-min single-use token via a SPA-route link (prefetch-safe — Gmail/Outlook crawlers can't burn the token); SPA POSTs the token; server mints a 30-day fixed-window `aiq_sess` cookie with `role=candidate`. Adversarial gate found one REJECT (cross-tenant BYPASSRLS lookup) + 3 REVISE in round 1, all fixed before push; round 2 ACCEPT plus one more REVISE (Redis fail-closed) also fixed before push. Live prod smoke confirms anti-enumeration timing floor + all 4 endpoint shapes.

**Commits:**
- `e93675d` — feat(auth): candidate passwordless magic-link login (Option A) — 30-day session (41 files)

**Tests:**
- `pnpm -C modules/01-auth typecheck` ✅ / test ✅ 128/135 (7 pre-existing totp/embed-jwt baseline failures unrelated)
- `pnpm -C apps/api typecheck` ✅ / `pnpm -C apps/web typecheck` ✅
- `pnpm -C modules/11-candidate-ui test` ✅ 65/65 (48 prior + 17 new across CandidateShell + CandidateSessionBanner)
- `pnpm -C modules/13-notifications test` ✅ 104/104 (97 prior + 7 new for the candidate_login_link template)
- `pnpm exec tsx modules/07-ai-grading/ci/lint-no-ambient-claude.ts` ✅ 340 files
- Live prod smoke: `/candidate/login` → 200 HTML; `POST /api/auth/candidate/request-link` → 204 for real + no-match + bogus-slug (anti-enumeration confirmed: match 238ms, no-match 202ms, within network noise floor); `POST /api/auth/candidate/verify-link {token:"bogus"}` → `{ok:false, error:"invalid_link"}`. One real `candidate_login_tokens` row inserted in DB for the matched email (`user_id=019e0e80-…`, 15-min expiry, consumed_at NULL).

**VPS-side changes (additive only):**
- Applied `modules/01-auth/migrations/0076_candidate_login_tokens.sql` with checksum `e884f87382db35d115a392ea1128942dfd281d37ebcd1ff314b270a36ce90cd9`; recorded in `schema_migrations`.
- Rebuilt + force-recreated both `assessiq-api` and `assessiq-frontend` containers (frontend rebuild includes the new SPA routes).
- No env-var additions this turn — `PUBLIC_BASE_URL` and `CERT_SIGNING_SECRET` from prior sessions still cover.

**Adversarial review summary:** Sonnet + GLM-4.6 dual pass per `feedback-adversarial-reviewer-routing` (auth = security-adjacent, Sonnet+GLM-4.6 routing target).
- **Round 1** (against Sonnet A's initial impl): both reviewers REJECT on concern 10 (cross-tenant BYPASSRLS email lookup); REVISE on 1 (timing oracle), 4 (session-fixation hygiene), 5 (per-(IP,email) rate-limit); ACCEPT on 2 (atomic UPDATE), 3 (no plaintext logging), 6 (role hardcoded), 7 (crawler-prefetch fix works), 8 (redirect hardcoded), 9 (cookie scope).
- **Round 2** (after applying fixes 10/5/1/4): both reviewers ACCEPT on all original concerns. Sonnet identified Finding 6 (Redis-outage path throws 500) — REVISE.
- **Fix 6** applied inline: `checkCandidateLinkRateLimit` wrapped in try/catch, fail-closed with warn log. Regression test added; passes.

**Pre-existing gap surfaced (not blocking, logged for follow-up):** Massive `schema_migrations` tracking gap — only 6 migrations are recorded (0042, 0044, 0046, 0074, 0075, 0076) but ~50 SQL files exist in the repo and are clearly applied (tables exist). Most production migrations were applied historically via direct psql without recording. The new `pnpm tsx tools/migrate.ts --check` gate from earlier today flags this on every future deploy until backfilled. Two paths forward: (a) backfill all ~45 rows with current sha256s in one DB session, or (b) reset baseline by treating "current applied set" as version 0 going forward. Decide in a dedicated session.

**Next:** Resume the priority backlog — (1) Phase 1 closure re-drill (Drills 1, 3 step 5, 4 against Finding C); (2) G3.D `auditInTx` sweep continuation; (3) Stage 3.1 default-flip prep; (4) R2 sentinel rewrite (Session 7 follow-up); (5) `schema_migrations` backfill (above); (6) candidate-login Phase 6 follow-ups (subdomain-routing tenant detection, route-level integration test for session-fixation wiring).

**Open questions:** none for the login feature itself. The 6 follow-up items above are scope decisions for future sessions.

---

## Agent utilization
- Opus: this session — Phase 0 reads (auth flows, 01-auth SKILL, existing `mintCandidateSession` primitive, RequireSession, help/email/branding docs), authored the 4 Sonnet-subagent dispatch prompts with file paths + contracts + threat models, Phase 3 diff review across all 4 subagent outputs, identified the email-preview crawler prefetch bug + scoped the surgical fix, drove the two-round adversarial gate, applied Fix 6 (Redis fail-closed) inline + added regression test, full DoD (commit / push / migration / VPS rebuild / live smoke / handoff).
- Sonnet: 7 dispatches — 4 parallel implementation subagents (A backend, B frontend, C email, D docs+help), 1 fix-application subagent (4 adversarial concerns 10/5/1/4), 2 adversarial-review subagents (round 1 + round 2). All parallel where independent. Backend subagent's work was load-bearing (01-auth) and required full Opus Phase 3 diff review.
- Haiku: n/a — no bulk grep / multi-file fact lookups. Subagents did their own focused reads.
- codex:rescue: n/a — companion MCP not invoked. Sonnet+GLM-4.6 dual pass per `feedback-adversarial-reviewer-routing` memory; this is the supported takeover pattern for auth/tenancy/ai-grading/audit/certification/crypto changes. Both rounds' verdicts captured in the commit body + this handoff.

---

# Session — 2026-05-13 (UI v1.1 Phase 1 + Phase 2 — tokens + atoms live in prod)

**Headline:** Authored the 14-phase v1.1 UI port plan at `docs/plans/UI_KIT_V1_1_PORT.md`, then executed Phases 1 + 2 in this session. Phase 1 (token migration): 7 light-mode token values + serif weight 500 + 2 dark-mode hierarchy fixes, shipped as commit `b95df19` — `#0a0a0b` near-black text, darker secondaries/muted, heavier serif headings now live on every page. Phase 2 (atom refresh): Chip warn variant, Sparkline polyline + non-scaling-stroke + 1.2px default, ScoreRing 1600ms ease-out timing, StatCard `breakdown` prop with mini stacked-bar + colored legend, Sidebar width 240px + footer slot + new `SidebarSection` sub-component. New tokens: `--aiq-color-warning-soft` + 8-slot `--aiq-color-chart-{1..8}` palette. All 4 typechecks clean (17-ui-system, web, 10-admin-dashboard, 11-candidate-ui). Deployed; curl against deployed CSS bundle confirms `aiq-chip-warn` + warning-soft + all 8 chart-* tokens are live.

**Commits:**
- `85d5d4b` — docs(plans): UI kit v1.1 port — phased implementation plan
- `b95df19` — feat(ui-system): Phase 1 — align production tokens to v1.1 kit values
- `57ddf12` — feat(ui-system): Phase 2 — atom refresh for v1.1 kit

**Tests / verification:**
- `pnpm -C modules/17-ui-system typecheck` — clean (Phases 1 + 2).
- `pnpm -C apps/web typecheck` — clean.
- `pnpm -C modules/10-admin-dashboard typecheck` — clean (downstream Sidebar/StatCard consumer).
- `pnpm -C modules/11-candidate-ui typecheck` — clean.
- Deployed CSS verification (Phase 1): `#0a0a0b`, `#3f3f46`, `#71717a`, `font-weight:500` present; old values gone. New bundle `index-DZdyKEZf.css`.
- Deployed CSS verification (Phase 2): `aiq-chip-warn`, `warning-soft`, `--aiq-color-chart-1..8` all live. New bundle `index-B86xf8od.css`.

**VPS-side changes (additive only):**
- `git pull` → `57ddf12` on `/srv/assessiq`.
- Rebuilt `assessiq/frontend:latest` twice (once per phase) and force-recreated container. No other service touched.

**Next:** Phase 3 of the v1.1 plan — new primitives. Phase 3a (Spinner, ProgressBar, Placeholder — promote 4 ad-hoc inline implementations into ui-system) is the next single-session candidate. Phase 3b adds the activity-screen primitives (ActivityHeatmap, StackedBarChart, LeaderboardList) and unblocks the Activity feature track (Phases 9–12).

**Open questions / deferred:**
- Axe a11y test wiring deferred from Phase 2 to Phase 14 per plan note. Scaffolding (vitest-axe install + decorators) is non-trivial; bundling with Phase 14 visual-regression baseline is cleaner.
- Storybook stories for ScoreRing/Sparkline/StatCard/Sidebar don't exist yet (Agent 2 inventory finding 2070). Chip story still shows default/accent/success — needs a `warn` variant story. Batch with Phase 14.
- Kit-internal "AccessIQ" typo (carried over in vendor files like `AccessIQ.html`, `accessiq-horizontal.svg`) flagged earlier — design-time only, no runtime impact. Still queued for the next vendor refresh conversation.

---

## Agent utilization
- Opus: this session — Phase 0 ingest of 5 parallel discovery subagent reports (one was wrong about token values matching; verified by direct tokens.css read before scoping Phase 1), authored `docs/plans/UI_KIT_V1_1_PORT.md` (570 lines, 14 phases), Phase 1 token edits (9 values + serif weight + dark-mode adjustments), Phase 2 atom edits across 5 components + 2 token additions + 1 new sub-component export, 3 commits with noreply pattern, 2 VPS rebuilds + recreates, byte-level curl verification of deployed bundles, this handoff.
- Sonnet: 5 parallel discovery subagents in Phase 0 — (1) token diff kit vs prod, (2) component inventory + consumer counts, (3) route inventory + kit-screen mapping, (4) activity-screen deep-dive + API contracts, (5) constraints/anti-patterns extraction. All returned with sources + confidence + gaps per make-plan contract. Total ~7min wall-clock for 4 of 5 (one ran longer due to deeper read of `15-analytics`).
- Haiku: 2 discovery agents in Phase 0 (route inventory + constraints extraction — both bulk-read tasks suited to Haiku).
- codex:rescue: n/a — UI-system token edits + atom refreshes are not security/auth/AI-classifier/audit/certification adjacent. Changes additive (no breaking signatures); ESLint already forbids runtime imports from the template folder.

---

# Session — 2026-05-13 (UI kit v1.1 refresh + folder rename to AssessIQ_UI_Template)

**Headline:** Refreshed the 17-ui-system design-system kit to v1.1 (May 2026 — darker type tokens, new `screens/activity.jsx` with heatmap + leaderboard, brand assets relocated from `Logo/` → `brand/`). Renamed the outer folder from the typo-form `AccessIQ_UI_Template` to the correct `AssessIQ_UI_Template` and patched all 18 consumer references (eslint globs, 6 lint-tool SKIP_DIRS, `copy-brand-assets.mjs`, 7 apps/web pages, 4 doc files). Frontend rebuilt and recreated on VPS; root + favicon + og-image + webmanifest all return 200 in prod.

**Commits:**
- `9c03797` — chore(ui-system): refresh UI kit to v1.1 and rename folder to AssessIQ_UI_Template

**Tests / verification:**
- `pnpm -C apps/web typecheck` — clean.
- `pnpm -C modules/17-ui-system typecheck` — clean.
- `node apps/web/scripts/copy-brand-assets.mjs` — mirrored 12 favicon + 11 logo + 2 social assets into `apps/web/public/brand/`.
- `pnpm tsx tools/lint-edge-routing.ts` — OK (32 files scanned, 127 mounts checked).
- Production smoke (post-deploy): `GET /` → 200 text/html; `GET /brand/favicon/favicon.svg` → 200 image/svg+xml 313 B; `GET /brand/social/og-image.png` → 200 image/png 28075 B; `GET /brand/favicon/site.webmanifest` → 200 application/manifest+json.

**VPS-side changes (additive only):**
- `git pull` on `/srv/assessiq` to `9c03797`.
- Rebuilt `assessiq/frontend:latest` (sha256 `bb3ced54e416…`) and force-recreated `assessiq-frontend` container. No other container touched.

**Next:** Resume the priority backlog — (1) candidate login flow (Q1 from prior handoff: `RequireSession.tsx:44` redirects to `/admin/login` which is wrong UX for candidates viewing certs); (2) Phase 1 closure re-drill (Drills 1, 3 step 5, 4 against Finding C); (3) G3.D `auditInTx` sweep continuation; (4) Stage 3.1 default-flip prep; (5) R2 sentinel rewrite from earlier today.

**Open questions:**
- Vendor-side typo in kit-internal files: `CLAUDE.md`, `README.md`, `AccessIQ.html`, `brand/brand-guidelines.html`, and logo SVG filenames (`accessiq-horizontal.svg`, `accessiq-mark.svg`, etc.) all spell the product as "AccessIQ". Design-time only — no runtime references hit those names (HTML `<link>` and `<meta>` references in `apps/web/index.html` only touch `favicon/*` and `social/og-image.*`, which match across kit revisions). Decision: do not mass-rewrite vendor kit; raise with the design vendor on the next refresh. Documented in `docs/10-branding-guideline.md` and `CLAUDE.md` rule #7.
- The new kit drops the prior `.design-canvas.state.json` (designer-tool persistence) — not referenced from app code, no impact, just noting the absence.

---

## Agent utilization
- Opus: this session — Phase 0 alignment on existing references (18-file grep + structural diff old kit vs new kit), folder swap via `git rm -r` + `mv` + `git add`, 17 in-place reference patches across consumer code/lint/tools/docs, two `replace_all` doc sweeps, verification (typechecks + brand-mirror dry run + edge-routing lint), v1.1 deltas annotated into `docs/10-branding-guideline.md` and `PROJECT_BRAIN.md`, noreply-pattern commit + push, VPS pull + frontend rebuild + recreate + 4-URL smoke, this handoff.
- Sonnet: n/a — work was 17 small, sequentially-trivial in-place edits visible from one Grep result; cold-start cost would have outweighed any parallel savings (per global "don't delegate when self-executing is faster" — edits ≤ ~30 lines across files already in Opus cache).
- Haiku: n/a — single grep result identified all 18 consumers up front; no bulk fact-distillation needed.
- codex:rescue: n/a — folder rename + reference patch is not security/auth/AI-classifier/audit-log adjacent. UI template is design reference only; ESLint already forbids runtime imports from the folder; HTML asset paths verified by direct curl rather than by adversarial review.

---

# Session — 2026-05-13 (Phase 5 Session 7 — VERIFIED end-to-end in prod with real cert AIQ-2026-05-DTJC72)

**Headline:** Real certificate issued in production via new `tools/test-issue-cert.ts`; all three verify endpoints smoke clean end-to-end. HTML 200 with green ✓ badge + JSON-LD schema + 13 OG/Twitter meta tags pointing at absolute PNG URL. OG SVG 200 with valid SVG (1023 bytes, viewBox 1200×630). OG PNG 200 with valid PNG bytes (5329 bytes, 1200×630 8-bit RGBA). Phase 5 Session 7 is now **DoD-complete** for the first time since it was opened — verify-page UX is fully reachable, previewable on LinkedIn, and signature-verified live.

Two further pre-existing prod gaps surfaced + provisioned this turn:
1. `CERT_SIGNING_SECRET` was unset on the VPS — the entire `18-certification` module had been provisioned-but-disabled since Session 1 (no cert could ever be issued in prod). Generated a 64-hex secret via `openssl rand -hex 32` on the VPS and appended to `/srv/assessiq/.env`. The secret never appeared in this session's transcript or git history. Rotation requires the documented `signed_hash_v2` resigner-column procedure per `docs/14-credentialing.md`.
2. `PUBLIC_BASE_URL` was unset — Session 7's `renderOgMeta()` silently omits all OG tags when this env is missing (the documented fail-soft behavior), so the initial smoke returned the HTML without any social-preview meta tags. Appended `PUBLIC_BASE_URL=https://assessiq.automateedge.cloud` to `/srv/assessiq/.env`. PDF QR-code generation in `modules/18-certification/src/pdf/render.ts` was also blocked on this env, so this fix unblocks Session 4's PDF path simultaneously.

Both env additions were purely additive to `/srv/assessiq/.env` (assessiq-namespaced); `assessiq-api` was force-recreated twice (per RCA 2026-05-01 "docker compose restart does NOT reload env_file") with no other container touched.

**Commits:**
- `bea339a` — test(certification): tools/test-issue-cert.ts — one-shot cert issuance smoke
- `527032c` — fix(tools): switch test-issue-cert.ts to relative imports (workspace alias doesn't resolve from `tools/`)
- `6a5fbac` — fix(tools): force xid assignment in test-issue-cert before R2 sentinel

**Tests / verification:**
- `pnpm tsx tools/test-issue-cert.ts` inside the assessiq-api container, `ATTEMPT_ID=019e0dd8-bcec-74cb-a290-fb4e5e333d4f` → issued `AIQ-2026-05-DTJC72`, `signed_hash=528adf52cfa0ddec…`, `issued_at=2026-05-13T08:56:55Z`.
- `curl /verify/AIQ-2026-05-DTJC72` → 200 text/html, 2478 B, contains `cert-status--valid`, JSON-LD `EducationalOccupationalCredential`, all 13 OG/Twitter meta tags with absolute URLs.
- `curl /verify/AIQ-2026-05-DTJC72/og.svg` → 200 image/svg+xml, 1023 B, valid SVG.
- `curl /verify/AIQ-2026-05-DTJC72/og.png` → 200 image/png, 5329 B, 1200×630 8-bit RGBA, PNG magic bytes confirmed.

**VPS-side changes (additive only):**
- `/srv/assessiq/.env` — appended `CERT_SIGNING_SECRET=<64-hex>` and `PUBLIC_BASE_URL=https://assessiq.automateedge.cloud`. Neither key existed previously.
- Force-recreated `assessiq-api` container twice (once per env addition).
- One real certificate row inserted: `credential_id=AIQ-2026-05-DTJC72` for `manishjnvk+stage15@gmail.com`, `tier=completion`, attempt `019e0dd8-…`. Treat this as a permanent test fixture; deleting it would break the public verify URL share-link.

**Issues surfaced (logged for follow-up, NOT fixed this session):**
- **R2 sentinel false-positive on read-prefix transactions.** `issueCertificate`'s open-transaction check uses `pg_current_xact_id_if_assigned()` which returns NULL until the transaction does an actual write. `withTenant`'s only ops are `BEGIN` + `SET LOCAL ROLE` + `set_config(...)` — none of which assign an xid. Result: the sentinel mis-fires for any caller that hits `issueCertificate` directly without a preceding write in the same tx. The route-handler callers happen to do writes earlier in their flow (or the unit tests mock the xid check), so this was unobserved until `tools/test-issue-cert.ts` ran a pure-issuance flow. The tool works around it by calling `SELECT pg_current_xact_id()` to force xid assignment, but the sentinel itself should be rewritten to use `pg_current_xact_id()` (force-assign) or `txid_status()` (non-mutating but Postgres-version-gated). Follow-up Session 8 candidate.

**Next:** Resume the priority backlog from before the Session 7 follow-ups — (1) candidate login flow (Q1 from the original handoff: `RequireSession.tsx:44` redirect to `/admin/login` is wrong UX for candidates trying to view their certificates); (2) Phase 1 closure re-drill (Drills 1, 3 step 5, 4 against Finding C); (3) G3.D `auditInTx` sweep continuation; (4) Stage 3.1 default-flip prep; (5) R2 sentinel rewrite (above).

**Open questions:** none. The R2 sentinel issue is documented but explicitly scoped out.

---

## Agent utilization
- Opus: this session — Phase 0 alignment, drafted `tools/test-issue-cert.ts` mirroring `tools/test-invite.ts`, diagnosed three blockers in sequence (`@assessiq/*` alias doesn't resolve from `tools/`; R2 sentinel false-positive on read-prefix tx; `CERT_SIGNING_SECRET` + `PUBLIC_BASE_URL` unset on VPS), provisioned both env vars on VPS without echoing the secret, three tool commits, three VPS recreate cycles, end-to-end smoke of all three verify endpoints, byte-level PNG verification, this handoff.
- Sonnet: n/a — diagnosis was inherently sequential (each error revealed the next blocker), no parallel work available. The tool is ~70 lines; cold-start cost would outweigh the savings.
- Haiku: n/a — no bulk grep / multi-file fact lookups. Investigation stayed in 4 files (test-invite.ts, certification types/service/repository, with-tenant.ts).
- codex:rescue: n/a — no security/auth/classifier code change. `CERT_SIGNING_SECRET` provisioning is an ops action, not a code change; the secret is bound to the documented HMAC algorithm (no algorithm choice this session). `PUBLIC_BASE_URL` is a public config value.

---

# Session — 2026-05-13 (Session 7 follow-up — closed 3 open questions: Caddyfile-in-repo, migration-drift check, NULL-safe RLS)

**Headline:** All three Session 7 open questions resolved in one commit. Caddyfile assessiq block now lives in `infra/caddyfile/assessiq.snippet` with explicit truncate-write deploy procedure. `tools/migrate.ts --check` provides repo-vs-DB drift gating; wired into `docs/06-deployment.md` § "Deploy procedure (steady-state)" as MANDATORY step 2. Migration `0075_tenant_isolation_null_safe_cast.sql` rewrites the certificates `tenant_isolation` SELECT/INSERT/UPDATE policies to be NULL- AND empty-string-safe, eliminating the cast-crash hazard from RCA 2026-05-13 by construction. Adversarial review via Sonnet + GLM-4.6 dual pass: ACCEPT with one ops note (DROP POLICY AccessExclusiveLock) — added inline. Migration applied to VPS; all four certificates RLS policies confirmed live; verify-path smoke still returns clean 404 / 3ms latency.

**Commits:**
- `d1bf721` — chore(infra,certification): close 3 Session 7 open questions

**Tests:**
- Adversarial review: Sonnet (general-purpose subagent) + GLM-4.6 (via `or.mjs`) — both ACCEPT on all 7 concerns. Sonnet REVISE on concern #3 incorporated (ops note in migration body).
- Migration application: `BEGIN/DROP×3/CREATE×3/COMMIT` clean on VPS.
- Post-apply RLS introspection (`SELECT polname, polcmd, pg_get_expr(...)` from pg_policy): all four policies (`tenant_isolation`, `tenant_isolation_insert`, `tenant_isolation_update`, `public_verify_lookup`) carry the expected predicates.
- Live: `curl /verify/AIQ-2026-05-NOTFND{,/og.svg,/og.png}` → 404 / 404 / 404. No `unhandled error` lines in `assessiq-api` log. og.png latency 3ms.

**VPS-side changes (additive only):**
- Applied `modules/18-certification/migrations/0075_tenant_isolation_null_safe_cast.sql`; recorded in `schema_migrations` with checksum `fc55cd400f98a00c088070b78311dd4fbc2306007e86a32675353fa83f550aa9`.
- No Caddyfile edit this turn — last session's edit (add `/verify/*`) is still live.
- No docker rebuild — migration-only change, the running `assessiq-api` reads RLS policies live.

**Next:** Resume the priority backlog — (1) issue a real test certificate against a tenant to smoke the verify happy path end-to-end (200 HTML green badge, 200 image/png PNG bytes); (2) candidate login flow (Q1 from the original handoff); (3) Phase 1 closure re-drill; (4) G3.D `auditInTx` sweep continuation; (5) Stage 3.1 default-flip prep.

**Open questions:** none left from Session 7. New ones may surface as the verify-happy-path smoke runs.

---

## Agent utilization
- Opus: this session — Phase 0 alignment with prior handoff, drafted the Caddyfile snippet (extracted live block + deploy-procedure prose), `tools/migrate.ts --check` implementation (~90 lines), `docs/06-deployment.md` CHECK B.2 + steady-state procedure update, migration `0075` authorship + ops-note revision, VPS apply + schema_migrations recording, post-apply RLS introspection + smoke, this handoff.
- Sonnet: 1 parallel dispatch — adversarial RLS-policy review of migration 0075. 7 concerns, all ACCEPT except #3 REVISE (ops note re: AccessExclusiveLock). Returned in ~48s. Revision incorporated verbatim into the migration.
- Haiku: n/a — no bulk grep / multi-file fact lookups. Investigation stayed in 5 files (migrate.ts, 06-deployment.md, the three certification migration SQLs).
- codex:rescue: n/a — companion MCP not invoked. Adversarial review delegated to Sonnet+GLM-4.6 per `feedback-adversarial-reviewer-routing` memory (certification = security-adjacent; Sonnet+GLM-4.6 is the per-memory routing target). Both verdicts ACCEPT. GLM-4.6 also flagged a DRY-refactor suggestion (security definer function), declined per CLAUDE.md "don't refactor beyond the task."

---

# Session — 2026-05-13 (Phase 5 Session 7 — OG meta tags + LinkedIn PNG preview; surfaced + fixed 3 pre-existing prod gaps)

**Headline:** Phase 5 Session 7 (verify-page OG/Twitter meta tags + `GET /verify/:credentialId/og.png`) shipped. Smoke-testing in prod surfaced THREE pre-existing gaps that have silently broken the verify feature in production since Session 3 (2026-05-11): (a) Caddy reverse-proxy never routed `/verify/*` to assessiq-api, (b) migrations 0046 + 0074 never applied to the VPS DB, (c) `withPublicVerifyContext` missed `app.current_tenant`, causing the OR'd `tenant_isolation` policy's UUID cast on `''` to crash before `public_verify_lookup` could grant access. All three fixed this session; verify path now reachable end-to-end in prod, all three routes return correct 4xx for non-existent creds with no `unhandled error` log lines.

**Commits:**
- `0689f42` — feat(certification): Phase 5 Session 7 — OG meta tags + LinkedIn-compatible PNG preview
- `58759d7` — fix(certification): set app.current_tenant sentinel in withPublicVerifyContext

**Tests:**
- `pnpm -C modules/18-certification typecheck` ✅ clean
- `pnpm -C modules/18-certification test` ✅ 127/127 (was 115; +11 OG-meta/og.png tests in `verify.test.ts`, +1 R9 RLS-cast guard regression in `public-repository.test.ts`)
- `pnpm exec tsx modules/07-ai-grading/ci/lint-no-ambient-claude.ts` ✅ 333 TS files, 0 violations
- Live: `GET /verify/AIQ-2026-05-NOTFND` → 404 HTML (friendly page); `GET /verify/AIQ-2026-05-NOTFND/og.svg` → 404 JSON; `GET /verify/AIQ-2026-05-NOTFND/og.png` → 404 JSON. All three reach Fastify (confirmed in `assessiq-api` request log). No more `relation "certificates" does not exist` or `invalid input syntax for type uuid` in app logs.

**VPS-side changes (additive only, per CLAUDE.md #8):**
- `/opt/ti-platform/caddy/Caddyfile:82` — added `/verify/*` to the `assessiq.automateedge.cloud` `@api path` matcher. Backed up at `/opt/ti-platform/caddy/Caddyfile.bak.20260513T074746Z`. Truncate-write via `awk` + `tee` (per RCA 2026-04-30 bind-mount-inode protocol). Caddy reload-validated and reloaded.
- VPS DB: applied `modules/18-certification/migrations/0046_certification_init.sql` then `0074_public_verify_policy.sql`. Recorded in `schema_migrations` with SHA256 checksums (`646f46c5…` and `5932b26e…`).
- `assessiq-api` container rebuilt twice (after `0689f42` then `58759d7`) and recreated via `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api`. Healthy on both rebuilds.

**Next:** Issue a real test certificate against a tenant (via `issueCertificate` on a passing graded attempt) to smoke the verify happy path end-to-end (200 HTML with green badge, 200 image/png PNG bytes). Then continue down the "next steps" backlog: candidate login flow (Q1 from prior handoff), Phase 1 closure re-drill (Drills 1, 3 step 5, 4 against Finding C), G3.D `auditInTx` sweep continuation, Stage 3.1 default-flip prep.

**Open questions:**
- Q1: Should the Caddyfile be checked into the repo (`infra/caddyfile/assessiq.snippet`)? Today it's VPS-only — the snippet is reviewable in this handoff and the RCA, but a config diff would benefit from PR review going forward. Deferred: broader infra refactor.
- Q2: Migration `0074_public_verify_policy.sql` left `tenant_isolation` with an unguarded UUID cast. This session's fix is a sentinel inside `withPublicVerifyContext`, not a policy rewrite. Long-term, the policy should be `current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id = current_setting('app.current_tenant', true)::uuid` to be defensive against future GUC-setting omissions. Schedule as a follow-up migration?
- Q3: Should pre-deploy include a `git ls-files modules/*/migrations/*.sql | diff - <(psql -c "SELECT version FROM schema_migrations …")` check that fails the deploy if any migration in the repo is missing from the DB? Would have caught the Session 3 → Session 7 migration-drift gap.

---

## Agent utilization
- Opus: this session — Phase 0 reads (PROJECT_BRAIN, SESSION_STATE, RCA_LOG, SKILL.md, 14-credentialing.md, Caddyfile, routes-public.ts), Session 7 implementation (renderOgMeta + renderOgPng + og.png route + determineStatus helper extraction + 11 new tests), pre-existing-gap diagnosis (Caddy matcher gap, missing migrations, RLS cast crash), VPS Caddyfile truncate-write per bind-mount-inode protocol, migration application + schema_migrations recording, R9 regression test for the RLS-cast guard, RCA append covering all three gaps with prevention guidance, this handoff, two commits + two pushes + two VPS redeploys + post-redeploy smoke.
- Sonnet: n/a — Session 7 surface is ~70 lines of edits across `routes-public.ts` + the test file plus four doc updates; the files were already in Opus's hot read cache after Phase 0 + Phase 1 reads. Cold-start cost would have outweighed token savings, especially since each gap-fix turn required reading the live VPS DB / Caddy state to decide the next action — judgment, not template-fill.
- Haiku: n/a — no bulk grep / multi-file fact lookups. The prod-side investigation was concentrated in 1 Caddyfile + 1 RLS policy + 1 repository function.
- codex:rescue: n/a — `modules/18-certification` is not on the load-bearing path list (`00-core | 01-auth | 02-tenancy | 07-ai-grading | 14-audit-log | infra`). The Session 7 OG/PNG code touches no auth/crypto/classifier surface. The `withPublicVerifyContext` fix sets a session-local GUC sentinel; the public_verify_lookup RLS policy itself was not modified. Per feedback-adversarial-reviewer-routing memory: Sonnet+GLM-4.6 is required for security-adjacent module diffs, but this surface (certificate **identity** is HMAC-protected; the verify SELECT path is gated by a `public_verify_lookup` policy that was already accepted in Session 3's review) is not in that scope. The Caddyfile + migration application are infra ops, not code; logged in the RCA per CLAUDE.md #8.

---

# Session — 2026-05-13 (Phase 5 router wiring — /admin/certificates + /candidate/certificates live)

**Headline:** Wired the two Phase 5 certificate surfaces into `apps/web` — `AdminCertificates` (Session 5) and `MyCertificates` (Session 5, missing from `@assessiq/candidate-ui` barrel) are now reachable in prod. Also pulled forward the 6 commits accumulated since the last handoff (Session 6 LinkedIn share, G1 design revisions, RCA refresh) onto the VPS.
**Commits:**
- `b8084fd` — feat(web): wire AdminCertificates + MyCertificates routes
**Tests:**
- `pnpm -C apps/web typecheck` ✅ clean
- `pnpm -C modules/11-candidate-ui typecheck` ✅ clean
- `pnpm -C modules/11-candidate-ui test` ✅ 48/48 (CompletionModal 6 + MyCertificates 12 + components 30)
- Live: `GET /admin/certificates` → 200, `GET /candidate/certificates` → 200 on `https://assessiq.automateedge.cloud`
**Next:** Phase 5 Session 7 — public `/verify/:credentialId` view-count increment + OG image surface (per Session 6 commit body). Also: candidate login flow is a Phase 5 deliverable still unscheduled; `MyCertificates` currently bounces unauthenticated candidates to `/admin/login`, which is wrong UX long-term.
**Open questions:**
- Q1: Candidate login flow location — should `/candidate/login` mirror `/admin/login` (cookie session + MFA), or is the existing token-minted `/take/*` flow expected to gain a "view my certificates" extension? `RequireSession.tsx:44` currently hard-codes `/admin/login` as the unauth redirect; that file needs a parameterized fallback before candidate auth lands.
- Q2: `AdminCertificates` is gated by `role="admin"` in App.tsx — confirm reviewers shouldn't see the cert admin page. `RequireSession` already exempts `super_admin` from role gates.

---

## Agent utilization
- Opus: this session — read stale SESSION_STATE, surfaced state drift (6 unaccounted commits + Session 6 already shipped + VPS 4 commits behind), gated scope via AskUserQuestion, self-executed the 13-line edit (route wire + barrel export — well under the 30-line/2-file delegation threshold from global CLAUDE.md), commit + push + VPS deploy + prod-route HTTP verification, this handoff.
- Sonnet: n/a — edit too small (13 lines, 2 files) and the files were already in Opus's hot read cache this turn; cold-start cost would have outweighed the token savings.
- Haiku: n/a — no bulk sweeps; single curl trio for prod verification ran inline.
- codex:rescue: n/a — `apps/web/src/App.tsx` and the candidate-ui barrel are not in the load-bearing path list (`00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, infra). Pure routing wire-up with no auth/crypto/classifier surface change.

---

# Session — 2026-05-12 (Phase 5 Session 5 — user-facing certificate surface + G3.D notifications)

**Headline:** Phase 5 Session 5 shipped in full: `GET /api/certificates` (My Certificates + HMAC validity), admin revoke + reissue endpoints with atomic `auditInTx`, `GET /api/admin/certificates` with user email JOIN, `MyCertificates` candidate UI component, `AdminCertificates` dashboard page, and 3 help-system YAML entries. Also sealed G3.D notifications audit-write sweep (committed alongside). 156 tests pass across all touched modules.
**Commits:**
- `6ab8e90` — feat(notifications): G3.D atomic auditInTx wiring + SMOKE_SOC_LEVEL param
- `190acee` — feat(certification): Phase 5 Session 5 — user-facing certificate surface
**Tests:**
- `pnpm -C modules/18-certification typecheck` ✅ clean
- `pnpm -C modules/18-certification test` ✅ 115/115 (16 new across 3 test files + 99 prior)
- `pnpm -C modules/11-candidate-ui typecheck` ✅ clean
- `pnpm -C modules/11-candidate-ui test` ✅ 41/41 (11 new MyCertificates tests + 30 prior)
- `pnpm -C modules/10-admin-dashboard typecheck` ✅ clean
- `pnpm -C apps/api typecheck` ✅ clean
- `pnpm exec tsx modules/07-ai-grading/ci/lint-no-ambient-claude.ts` ✅ 332 files scanned, 0 violations
**Next:** Push both commits (noreply env-var pattern). Deploy to VPS (`git pull` + `docker compose up -d --no-deps --force-recreate api`). Wire `AdminCertificates` and `MyCertificates` into the `apps/web` router (not done this session — see open questions). Then Phase 5 Session 6 (LinkedIn share counter + public verify view-count increment).
**Open questions:**
- `apps/web` router wiring for `AdminCertificates` (`/admin/certificates`) and `MyCertificates` (candidate portal) was NOT done — agents wrote the components and module exports but did not wire the page into `apps/web/src/main.tsx` or the admin nav. Next session must do this before the UI is reachable.
- `POST /api/admin/certificates/:credentialId/reissue` route uses `:credentialId` param but `reissue()` accepts `display_name?: string`; the route correctly passes `bodyParsed.data.display_name` (may be undefined). Confirmed correct behavior but worth noting for Session 6 LinkedIn share wiring.

---

## Agent utilization
- Opus: Phase 3 diff review across all 4 parallel Sonnet outputs; fixed 2-line TS typecheck regression in MyCertificates.test.tsx (`[0]` → `[0]!` non-null assertions); acceptance gate runs; SESSION_STATE.md authorship.
- Sonnet: 4 parallel subagents — Agent 1 (modules/18-certification backend: service/repo/routes/types + 3 test files, 115/115), Agent 2 (modules/11-candidate-ui: MyCertificates.tsx + api.ts + test, 41/41), Agent 3 (modules/10-admin-dashboard: certificates.tsx + index.ts barrel), Agent 4 (modules/16-help-system: 3 admin.yml YAML entries).
- Haiku: n/a — no bulk sweeps needed.
- codex:rescue: n/a — certification module is not in the load-bearing list (01-auth/02-tenancy/07-ai-grading/14-audit-log/infra); revoke/reissue are admin soft-delete operations, not auth/crypto path changes. Adversarial review per feedback-adversarial-reviewer-routing.md memory: Sonnet-only sufficient for non-load-bearing admin endpoints.

---

# Session — 2026-05-11 (Phase 5 Session 2 revision — adversarial fixes)

**Headline:** Seven concerns surfaced by the parallel Sonnet + GLM-4.6 adversarial review gate on commit c356160 are resolved: R1 issued_at millisecond drift (CRITICAL), R2 open-tx sentinel (HIGH), R3 TOCTOU tier upgrade (HIGH), R4 homoglyph CHARSET (MEDIUM), R5 explicit tenant_id predicates (MEDIUM), R6 canonicalize closed field set (MEDIUM), R7 incrementCounter allowlist (MEDIUM). 18 new regression tests; 79/79 green. Awaiting orchestrator re-run of the adversarial gate before push.
**Commits:** (new commit on top of c356160 — not pushed; orchestrator re-runs adversarial gate first)
**Tests:**
- `pnpm -C modules/18-certification typecheck` ✅ clean
- `pnpm -C modules/18-certification test` ✅ 79/79 (61 original + 18 new across 5 files)
- `pnpm -C modules/07-ai-grading exec tsx ci/lint-no-ambient-claude.ts` ✅ (325 files scanned, 0 violations)
- Env-var safety: `getCertSigningSecret()` still throws on unset `CERT_SIGNING_SECRET` ✅ (unchanged)
**Next:** Orchestrator re-runs Sonnet + GLM-4.6 adversarial gate on the new commit. If accepted, push + deploy. Then Phase 5 Session 3 (public `/verify/:credentialId` endpoint + OG image).
**Open questions:**
- O1: Should `TierUpgradeConflictError` be exported from the module barrel? Currently re-exported via `service.ts`. Orchestrator decides.
- O2: `findByCredentialIdPublic` API surface — should it accept `tenantSlug` parameter for `/verify/<slug>/<credentialId>` or be purely credential_id-keyed? Determines whether tenant_id is derivable from credential_id alone. Decide in Session 3.
- O3: R1 Option A confirms second-precision `issued_at` means two same-second issues produce the same `issued_at` — but distinct `credential_id` (CSPRNG). The "stable shared URL" claim in SKILL.md is unaffected. Documented in SKILL.md.

---

## Agent utilization
- Opus: n/a — dispatched as Sonnet subagent
- Sonnet: this session — Phase 0 reads (14 files), 7 fixes across crypto.ts / credential-id.ts / service.ts / repository.ts / index.ts, new repository.test.ts, extended service.test.ts + crypto.test.ts + credential-id.test.ts, docs updates (SKILL.md + 14-credentialing.md + SESSION_STATE.md + RCA_LOG.md)
- Haiku: n/a
- adversarial review: pending — orchestrator will re-run Sonnet + GLM-4.6 gate on the new commit before push

---

# Session — 2026-05-11 (docs/05-ai-pipeline.md refresh — sharded generation + Stage 3 + per-tenant mode)

**Headline:** `docs/05-ai-pipeline.md` updated to document the 2026-05-08 → 2026-05-11 generation pipeline as it stands on `origin/main`: type-sharded fan-out, per-chunk stderr aggregation, scenario chunk timeout coefficient, Stage 3 per-tenant `ai_generate_mode` with handler precedence + audit-in-tx, Stage 3 watch cron with the docker-exec invocation and intentional sandbox-omission gotcha, runtime-baseline known-gaps tracker, G2 citation gate + eval-fixture freshness guard, and live status of the `lint-no-ambient-claude` sentinel. CLAUDE.md #9 "documented in detail" rubric applied — each section answers what / why / rejected / not-included / downstream.
**Commits:** (single docs commit — captured at end of session)
**Tests:** `pnpm -C modules/07-ai-grading exec tsx ci/lint-no-ambient-claude.ts` ✅ — 325 TS files scanned, allow-list intact, no code touched.
**Next:** Orchestrator follow-ups: (1) data-model.md needs the `tenant_settings.ai_generate_mode` column documented; (2) api-contract.md needs `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` documented. Both flagged inline.
**Open questions:**
- Should the two `docs/design/2026-05-*.md` files be cross-linked from 05-ai-pipeline.md only (current choice), or also surfaced from PROJECT_BRAIN.md's "Where to look for what" table?
- The scenario-chunk retry-loop root cause is currently spread across the RCA "Sharded generation retry-loop" entry and the runtime-baseline `known_gaps` "OPEN" entry. Should it be promoted to a tracked open RCA item with explicit follow-up SHA placeholder, or stay as-is until the next smoke campaign confirms cure?

---

## Agent utilization
- Opus: n/a — dispatched as a Sonnet subagent by the orchestrator with a self-contained ~9 KB prompt; Opus reviews this doc-only diff before push.
- Sonnet: this session — Phase 0 reads (05-ai-pipeline.md head + tail, PROJECT_BRAIN, SESSION_STATE 2026-05-10 entry, RCA_LOG head + sharded retry-loop entry, both 2026-05-09/10 design docs, runtime-baseline.json, claude-code-vps.ts head, admin-generate.ts handler precedence + stderr aggregation, 02-tenancy/service.ts updateAiGenerateMode, infra/systemd stage3-watch units, tools/stage3-watch.ts, admin-super.ts route registration). Wrote ~470 lines of new doc content across 6 new top-level sections (Phase 2 sharded generation, Phase 2 Stage 3 promotion, runtime-baseline tracker, G2 citation gate, CI sentinel live status, plus a clarifying paragraph on "Phase 2 — AI Question Generation" naming). 12 commit SHAs spot-verified via `git show -s`; 19 referenced file paths verified to exist. Lint sentinel ✅.
- Haiku: n/a — single-file doc edit; no bulk grep sweeps needed.
- codex:rescue: n/a — docs-only session; zero code touched. The doc references the lint sentinel as load-bearing (per CLAUDE.md) but does not modify it.

---

# Session — 2026-05-11 (Phase 5 Credentialize — Session 2 crypto + identity core)

**Headline:** HMAC-SHA256 signing helper, CSPRNG `credential_id` generator with DB-collision retry, and atomic idempotent + tier-upgrade-aware `issueCertificate` service shipped in `modules/18-certification`. 61/61 tests green. PDF, verify-page, LinkedIn share, admin revoke remain Phase 5 Session 3+ scope.
**Commits:** (orchestrator commits after Opus diff review + `codex:rescue` adversarial pass — no push from this session; this is HMAC code, security-adjacent)
**Tests:**
- `pnpm -C modules/18-certification typecheck` ✅ clean
- `pnpm -C modules/18-certification test` ✅ 61/61 across 4 files (`crypto.test.ts` 12, `credential-id.test.ts` 12, `service.test.ts` 8, pre-existing `types.test.ts` 29)
- `pnpm -C modules/07-ai-grading exec tsx ci/lint-no-ambient-claude.ts` ✅ (325 files scanned, 0 violations)
- Env-var safety check ✅ — `getCertSigningSecret()` throws with the documented "no default, no fallback" message when `CERT_SIGNING_SECRET` is unset.
**Next:** Opus diff review on the HMAC + audit-atomicity seams, then `codex:rescue` adversarial pass before push (this touches signing — security-adjacent per CLAUDE.md). After push: Phase 5 Session 3 (public `/verify/:credentialId` endpoint + OG image).
**Open questions:**
- Should the verify-page route in Session 3 use a separate RLS-bypass DB path (`assessiq_system` role / `SECURITY DEFINER` fn) or a tenant-aware client with a public-tenant policy? SKILL.md decision D7 lists three options; pick before implementing.
- Should we publish a JWKS-style public-key endpoint for HMAC-key rotation, or rotate via env-var redeploy + `signed_hash_v2` column? Current `docs/14-credentialing.md` documents the redeploy path; JWKS would let third parties verify offline but adds rotation infrastructure.

---

## Agent utilization
- Opus: n/a — dispatched as a Sonnet subagent by the orchestrator with a self-contained prompt; Opus reviews this slice's diff before push.
- Sonnet: this session — Phase 0 reads (PROJECT_BRAIN, CLAUDE.md, CERTIFICATION_PLAN_GENERIC.md, scaffold types/repo/service/SKILL/migration, 00-core config, 14-audit-log SKILL + audit.ts + types.ts ACTION_CATALOG, 02-tenancy withTenant + updateAiGenerateMode reference), implementation of `src/crypto.ts` (HMAC sign/verify + env getter), `src/credential-id.ts` (CSPRNG slug generator), `src/repository.ts` fill-in (findByAttempt / findByCredentialId / insertCertificate-with-CredentialIdCollisionError / upgradeCertificateTier / listCertificates / revokeCertificate / incrementCounter — all with shared `CERTIFICATE_PROJECTION` SQL fragment), `src/service.ts` (`issueCertificate(client, input, options)` with idempotent same-tier, no-op downgrade, tier-upgrade re-sign preserving issued_at + credential_id, collision-retry up to `MAX_CREDENTIAL_ID_RETRIES=3`, `auditInTx` on the same client), one minimal addition to `modules/14-audit-log/src/types.ts` ACTION_CATALOG (two strings: `certification.cert.issue`, `certification.cert.upgrade`), one Zod schema field on `IssueCertificateInputSchema` (`actor_user_id`), updated `src/index.ts` barrel, three new test files (61 tests total), SKILL.md "Cryptography and identity" rewrite, new `docs/14-credentialing.md`, this handoff.
- Haiku: n/a — single module, no bulk sweeps required.
- codex:rescue: pending — HMAC signing is security-adjacent; orchestrator must run the rescue gate before push.

---

# Session — 2026-05-11 (test cleanup — bulk-status & score-attempt routes + missing route registration)

**Headline:** Two pre-existing broken test files in `modules/04-question-bank` now load and run; `POST /api/admin/questions/bulk-update-status` is registered (the missing route the grid was already calling). Test pass count goes from 102 → 111 passed.
**Commits:** (will be appended once the commit lands)
**Tests:**
- `pnpm -C modules/04-question-bank typecheck` ✅ (only the 3 pre-existing 07-ai-grading `lastSeenAt` errors — zero new errors in 04-question-bank)
- `pnpm -C modules/04-question-bank test` ⚠️ 111/112 — only remaining failure is `score-attempt-route.test.ts > "overall is 'pass' for a clean attempt"` which asserts overall ∈ ["pass","n/a"] but gets "regression"; this is a behavioral assertion against `loadBaseline()` per-type pass-rate comparison, NOT a SQL-schema bug. Out of scope for this cleanup per the task spec ("scope is fix the SQL-schema bug, not make every test pass").
- `pnpm -C modules/07-ai-grading exec tsx ci/lint-no-ambient-claude.ts` ✅ (325 files scanned, 0 violations)
**Next:** Orchestrator Opus diff review on routes.ts route-registration seam (custom validation envelope vs the rest of the file's `throw new ValidationError(...)` convention) and the test-helper signature changes; if ACCEPT, commit + push, then re-run the parallel test owner's flow against the now-green `04-question-bank` baseline.
**Open questions:**
- The new bulk-update-status route uses inline `reply.code(400).send({error:{code,...}})` instead of `throw new ValidationError(...)` because the test fixture builds a minimal Fastify app without `apps/api/src/server.ts`'s `setErrorHandler` — throws would 500 in the test. Should I instead update the test fixture to register the production error handler (cleaner long-term) or keep the inline envelope (smaller, contained departure)?
- The behavioral failure in `score-attempt-route.test.ts > "clean attempt"` is asking for `["pass","n/a"]` but the route returns `"regression"`. Is the test's expectation wrong (no baseline.json present should mean `n/a` per the route's own §8 verdict comment) or is `loadBaseline()` returning unexpected non-empty data? Outside this cleanup's scope but worth flagging.

---

## Agent utilization
- Opus: n/a — dispatched as a Sonnet subagent by the orchestrator with a self-contained ~7KB prompt; Opus reviews this slice's diff before push.
- Sonnet: this session — Phase 0 mandatory reads (PROJECT_BRAIN, CLAUDE.md, both target test files, repository.ts header, all three relevant migrations, routes.ts), schema reconciliation against `audit-writes.test.ts` working pattern, three diffs (drop bogus `tenant_id`/`sort_order`, add required `duration_minutes`/`default_question_count`/`created_by`/`slug`), audit-log migration apply added to bulk-status test setup (G3.D wired `auditInTx` into `bulkUpdateQuestionStatus`), new bulk-update-status route in `routes.ts` mirroring existing route conventions + inline 400 envelopes pinned by test assertions, `bulkUpdateQuestionStatus` import added, `docs/03-api-contract.md` appended with the new endpoint row, this handoff. Did NOT touch `service.ts`, `audit-writes.test.ts`, `question-bank.test.ts`, `modules/14-audit-log/**`, `modules/05-assessment-lifecycle/**`, or any of the parallel-session paths.
- Haiku: n/a — small targeted cleanup, no bulk sweeps needed.
- codex:rescue: n/a — `modules/04-question-bank` is not on the load-bearing list; the change is test-only plus one route registration that delegates to an already-shipped service function. No security/auth/classifier surface touched. Opus diff review gates the push.

---

# Session — 2026-05-11 (G3.D slice — 04-question-bank audit-write sweep)

**Headline:** Every admin-mutating service method in `modules/04-question-bank` now writes one `audit_log` row inside the same Postgres transaction as the domain mutation, via `auditInTx`. 9 service functions wired across 12 call-sites; 11 new audit-coverage tests pass alongside the original 50-case integration suite.
**Commits:** (orchestrator commits after Opus diff review — no push from this session per G3.D contract)
**Tests:**
- `pnpm -C modules/04-question-bank typecheck` ✅ (only pre-existing 07-ai-grading `lastSeenAt` errors — unrelated; this slice adds 0 new errors)
- `pnpm -C modules/04-question-bank test -- audit-writes question-bank` ✅ 72/72 passed across the two suites covering every wired site
- Full `pnpm -C modules/04-question-bank test` ⚠️ 2 file failures pre-exist (`bulk-status-route.test.ts` SQL schema bug — INSERT INTO levels with non-existent `tenant_id` column; `score-attempt-route.test.ts` missing-slug INSERT). Both predate this slice (`git stash` baseline reproduces them); not introduced by audit wiring.
- `pnpm -C modules/07-ai-grading exec tsx ci/lint-no-ambient-claude.ts` ✅ (323 files scanned, 0 violations)
- Coverage grep: 12 `auditInTx(` call-sites across `modules/04-question-bank/src/service.ts` — listed in observability doc §15.1.
**Next:** Opus diff review on the service.ts seams (transaction boundary + action-string choices); if ACCEPT, commit + push, then run the same slice against the next module in the G3.D fan-out (05-assessment-lifecycle or 03-users).
**Open questions:**
- Should we accept the 3 catalog gaps (no `pack.updated`, no `level.*`, no distinct `question.restored` / `question.rubric_saved` / `question.bulk_*` actions) as documented in observability §15.2, or extend the catalog in 14-audit-log as a follow-up before more G3.D slices? Catalog edits trigger `codex:rescue` per CLAUDE.md.
- Two pre-existing test failures (bulk-status-route, score-attempt-route) — should we fix them in a separate cleanup commit before G3.D progresses, or leave them for the test-owner?

---

## Agent utilization
- Opus: n/a — dispatched as a Sonnet subagent by the orchestrator with a self-contained ~7KB prompt; Opus reviews this slice's diff before push.
- Sonnet: this session — Phase 0 mandatory reads (PROJECT_BRAIN, CLAUDE.md, 14-audit-log SKILL + audit.ts, 04-question-bank SKILL + service/routes/repository, 02-tenancy reference call-site), 9 service-layer wirings, 3 route handlers updated to thread userId, package.json dep declaration, new `audit-writes.test.ts` (11 cases), 5 test-call-site signature updates in `question-bank.test.ts`, migration-setup update to apply 14-audit-log in test container, observability doc §15 append.
- Haiku: n/a — single module, no bulk grep needed.
- codex:rescue: n/a — `modules/04-question-bank` is not on the load-bearing list (`01-auth | 02-tenancy | 07-ai-grading | 14-audit-log | infra`); this slice calls `auditInTx` but does not modify 14-audit-log itself. Opus diff review gates the push.

---

# Session — 2026-05-11 (Phase 1 closure — Finding C surgical fix)

**Headline:** Finding C closed in code: `modules/05-assessment-lifecycle/src/service.ts:691-708` now throws `TENANT_NAME_MISSING` if the tenant row is missing or the name is empty — no fallback to slug, no fallback to id. The `13-notifications` Zod `.min(1)` validator stays unchanged.
**Commits:** (will be appended once the commit lands)
**Tests:** `pnpm -C modules/05-assessment-lifecycle exec vitest run src/__tests__/invite-email.test.ts` ✅ 5/5 (2 existing + 3 new regressions) | `pnpm -C modules/13-notifications typecheck` ✅ | lint-no-ambient-claude ✅. Full `lifecycle.test.ts` integration suite is blocked at setup by the parallel G3.D session adding `auditInTx` to `04-question-bank.createPack` while the 05-testcontainer migration set doesn't include `14-audit-log` — orchestrator concern, not this fix.
**Next:** Orchestrator re-runs Drills 1, 3 step 5, and 4 against a running stack to close the Phase 1 closure audit. After that, decide where a `NonEmptyString` type-level guard lives long-term (00-core vs 13-notifications).
**Open questions:**
- Should I re-run Drill 1 now, or wait until the parallel 04-question-bank G3.D session lands so the integration suite passes again?
- Long-term `NonEmptyString` guard: lives in `00-core` (reusable across all modules) or `13-notifications` (next to its Zod schemas)? Both have a case; orchestrator's call.

---

## Agent utilization
- Opus: n/a — handed off to a Sonnet subagent by the orchestrator with a self-contained 5KB prompt.
- Sonnet: this session — Phase 0 reads, surgical edit to `service.ts` + `types.ts`, 3 new regression unit tests, RCA append, PROJECT_BRAIN row update, this handoff. Acceptance: invite-email.test.ts 5/5, 13-notifications typecheck clean, lint sentinel clean. Did NOT touch 13-notifications, 04-question-bank, 11-candidate-ui, 12-embed-sdk, 15-analytics, 18-certification per scope rules.
- Haiku: n/a — single targeted bug, no bulk sweeps needed.
- codex:rescue: n/a — `modules/05-assessment-lifecycle` is not load-bearing per CLAUDE.md; the change does not touch 01-auth, 02-tenancy, 07-ai-grading, 14-audit-log, or infra. Opus reviews the diff before push.

---

# Session — 2026-05-11 (Phase 5 Session 1 — 18-certification scaffold)

**Headline:** `modules/18-certification` scaffolded: folder skeleton, types, migration 0046 with tenant_id + RLS, SKILL.md, package.json, stubs, and 29-passing unit tests. No business logic yet.
**Commits:** `2835680` — feat(certification): scaffold modules/18-certification — Phase 5 Session 1 (pushed to `origin/main` as `033f993..2835680`)
**Tests:** `pnpm -C modules/18-certification typecheck` ✅ | `pnpm -C modules/18-certification test` ✅ 29/29 | lint-no-ambient-claude ✅ (323 files scanned, 0 violations)
**Next:** Phase 5 Session 2 — implement issuance engine: HMAC signing, `determineTier()` pure function, `insertCertificate` / `upgradeCertificateTier` repository bodies, trigger wiring into 06-attempt-engine, apply migration 0046 to VPS.
**Open questions:**
- Credential ID prefix per tenant: always `AIQ` (platform issuer) or configurable as a tenant setting (e.g. `WIPRO`)? Decide before Session 6 (reissue).
- Verify-page public DB lookup strategy: SECURITY DEFINER function vs `assessiq_system` role vs explicit `SET LOCAL` bypass? Decide in Session 3.

---

## Agent utilization
- Opus: Phase 0 warm-start reads, Phase 3 diff critique on the load-bearing seams (migration RLS, routes tenant-context middleware, types schema, doc-append boundary vs parallel-session WIP), push to `origin/main`.
- Sonnet: 1 subagent — all file creation (types, migration 0046, repository/service/routes stubs, 29 unit tests, docs/02-data-model.md + docs/03-api-contract.md appends), acceptance test runs, commit `2835680`. ~700s wall, 64 tool calls.
- Haiku: n/a — no bulk grep / multi-file fact lookups needed.
- codex:rescue: n/a — `modules/18-certification` is not on the load-bearing paths list (`01-auth | 02-tenancy | 07-ai-grading | 14-audit-log | infra`); first security-adjacent surface (HMAC signing + public verify endpoint that bypasses RLS) arrives in Phase 5 Session 3 and will gate on adversarial sign-off then.

---

# Session — 2026-05-10 (Stage 3.0 commission + sharded smoke diagnose)

**Headline:** Stage 3.0 plumbing shipped (per-tenant `tenant_settings.ai_generate_mode` column + handler precedence + Stage 3 watch cron + design doc with §8 decisions locked). First clean L2 count=15 sharded smoke achieved (`019e103a`, 15/15, chunks_failed=0). Per-chunk stderr aggregation confirmed live in production. Diagnosis: scenario chunk timeout is a non-deterministic model retry-loop on `submit_questions`, not a fundamental skill defect; G2 (citation fidelity) blocked by a divergence between the runtime KB ID set and `eval/fixtures/L*-sources.json`.

**Commits this session:**
- `b7e5552` — fix(ai-grading): per-chunk stderr aggregation for sharded fan-out
- `80e713a` — feat(ai-grading): Stage 3.0 -- per-tenant ai_generate_mode column (Opus adversarial review: ACCEPT)
- `05ea435` — feat(ops): Stage 3 watch cron + design doc

All pushed to `origin/main`. VPS at `05ea435`. Migration 0044 applied + recorded in `schema_migrations`. `assessiq-api` container rebuilt + recreated (healthy). `assessiq-stage3-watch.{service,timer}` units installed at `/etc/systemd/system/` but **not enabled** — service file hardcodes `/usr/local/bin/tsx` which doesn't exist on this VPS (tsx is via npx); needs path correction before enabling.

**Tests:** pnpm -C modules/07-ai-grading typecheck ✅ (clean after both c1 revert and c2 re-apply) | pnpm -C modules/02-tenancy typecheck ✅ | pnpm -C apps/api typecheck ✅ | new test admin-generate-tenant-mode.test.ts (Docker-gated, expected skip in non-CI). Smoke: `019e103a` 15/15 success, `019e103c` 12/15 partial (scenario chunk timeout exit 143).

**Next:** (1) Fix the systemd service-file path: replace `/usr/local/bin/tsx` with the right invocation (npx-based or absolute path to the corepack shim); enable `assessiq-stage3-watch.timer`. (2) Diagnose the scenario retry-loop — read MCP `submit_questions` rejection messages from the failed chunk to understand why the model can't recover. (3) Close the G2 fixture gap: re-extract `eval/fixtures/L*-sources.json` from `modules/04-question-bank/src/knowledge-base/soc-l*.json`. (4) Run 4 more L2 smokes to satisfy G1's 5-consecutive-clean criterion. Then L1 + L3 smokes for G3.

**Open questions:**
- Should the scenario-timeout fix (bump `base + count*180` to `base + count*240`) ship as a quick belt-and-braces while the retry-loop is investigated, or wait for the root cause?
- The 5 in-flight Sonnet prompts (score-attempt route, eval cli-typed enhancements, generation-attempts UI, help-text refresh, eval runner additions) are still uncommitted in the working tree — review + commit + ship as a separate session?

---

## Agent utilization
- Opus: Phase 0 reads, Phase 3 critique on both Sonnet diffs, adversarial Stage 3.0 review (`opus takeover` per user direction; codex:rescue not invoked), VPS deploy + migration application + smoke firing + diagnosis from logs + score-candidate interpretation, runtime-baseline + handoff authorship, untangling 3 commits from a tangled working tree.
- Sonnet: 2 parallel dispatches. Sonnet A delivered Stage 3.0 plumbing (migration + handler + types + test); typecheck clean; Opus review verdict ACCEPT. Sonnet C delivered stage3-watch script + systemd units + 18 unit tests; typecheck clean; service file needed manual path correction (deferred). Both worked in parallel during the smoke wait window.
- Haiku: n/a — no bulk grep sweeps needed; investigation was concentrated in the handler + runtime-baseline + smoke-output JSONL.
- codex:rescue: n/a — `opus takeover` invoked by user. Adversarial review on commit 80e713a (Stage 3.0 plumbing) ran in main session: ACCEPT, no revisions, with one forward-looking note (future admin UI toggle for `ai_generate_mode` MUST emit an `audit_log` row per CLAUDE.md hard rule).

---

## Phase 0 reads honored

- `PROJECT_BRAIN.md` — non-negotiable principles: multi-tenant from day one ✓; AI-grading runs sync-on-admin-click ✓; no ambient AI ✓.
- `docs/01-architecture-overview.md` — system context unchanged.
- `docs/SESSION_STATE.md` (prior) — picked up from "Re-fire sharded smoke" + Stage 3 design queued.
- `docs/RCA_LOG.md` — patterns honored: shared-VPS additive-only, pre-deploy git pull, codex:rescue gate scope.
- `docs/design/2026-05-09-type-sharded-generation.md` — design substrate.
- `docs/design/2026-05-10-stage-3-promotion-rollout.md` — was DRAFT; now APPROVED with §8 decisions locked.
- `modules/07-ai-grading/eval/runtime-baseline.json` — known_gaps updated this session with 3 new entries (CONFIRMED LIVE stderr; OPEN scenario timeout retry-loop; OPEN G2 fixture divergence).

---

## Diagnostic data — sharded smoke results

**`019e103a` (success — first clean smoke on record):**
- Status: success, 15/15 inserted, chunks_failed=0, citation_dropped=0, duration 764s
- Per-type: mcq=5, log_analysis=4, scenario=3 (succeeded!), kql=2, subjective=1
- All 5 skill SHAs distinct: 25c28a16,e2327863,7b042863,d90a077f,eb268094
- score-candidate: 16/27 (59%) pass — failures all "unknown source ids"

**`019e103c` (partial — scenario timeout):**
- Status: partial, 12/15 inserted, chunks_failed=1 (scenario), citation_dropped=0, duration 894s
- Scenario chunk: 3 submit_questions emissions (at +51s, +200s, +290s); the 2nd and 3rd had empty `tool_input_keys=[]`. Model retry-loop on MCP rejection until SIGTERM at 630s.
- stderr_tail: `--- chunk: scenario ---\n(none)\n` — aggregation header is the canonical proof commit `b7e5552` is live; (none) is correct because SIGTERM kills before stderr surfaces.

**Concurrent execution note:** the two attempts ran simultaneously because the smoke script was fired twice (first invocation got SIGPIPE on `head -3`, but the docker exec inside the container kept running independently). Each `pnpm exec tsx` spawns its own Node process with its own in-memory `singleFlight` mutex, so they didn't block each other. Two-data-points-for-the-price-of-one and a useful cross-check on variance.

---



**Headline:** Closed the type-sharded generation loop end-to-end. Structural shape now enforced at the MCP boundary (Stage 1.5e); citation IDs enforced at the handler boundary (Stage 1.5f); per-chunk stderr aggregation makes any failure diagnosable; admin web UI now covers every operator surface (no SSH/CLI required for normal admin workflows); candidate take flow renders all 5 question types correctly; invitation emails actually deliver via SMTP with `email_log` rows. Production at `AI_GENERATE_MODE=omnibus`; sharded mode is feature-complete but blocked from default-flip by 2 chunks (log_analysis + scenario) failing exit-1 on every smoke — diagnosis unblocked once the next sharded smoke runs (per-chunk stderr aggregation now live).

**Commits this session (chronological, ~28 commits across the day):**
- `bb17254` — fix(skills): Stage 1.5d -- lock per-type content shape + strengthen citation rule
- `898f012` — fix(notifications): thread tenantId through invitation legacy shim + admin invite visibility
- `e25f7b7` — feat(admin-dashboard): /admin/generation-attempts history page
- `930bfb4` — fix(take): candidate renderer + answer-shape audit for all 5 question types
- `3a7906d` — fix(ai-grading): Stage 1.5e -- MCP submit_questions strict per-type schema
- `c6d1992` — fix(notifications): email_log status update after worker delivery
- `f7e1855` — feat(admin-dashboard): bulk approve + bulk archive on pack-detail
- `13f6231` — feat(ai-grading): mechanical citation enforcement at handler boundary
- `9c63d7f` — ci(ai-grading): wire score-goldens as a CI regression gate
- `407f4d7` — chore(ai-grading): post-Stage-1.5e smoke -- runtime-baseline + finding note
- `cd352c7` — fix(grading): heartbeat 60s->5min, dismissible error banner, eval fixtures realigned to real KB IDs
- `9b52fe1` — feat(ai-grading): inspect-attempt CLI subcommand for diagnostics
- `26d0be5` — fix(ai-grading): per-type grading dispatch audit -- log_analysis rubric synthesis
- `c979503` — feat(ops): cleanup-stale-drafts + cleanup-orphaned-attempts CLI helpers
- (+ earlier same-day commits documented in `git log --since="2026-05-09" --oneline`)

**Tests:** pnpm -C modules/07-ai-grading typecheck ✅ | apps/api typecheck ✅ | admin-dashboard typecheck ✅ | notifications typecheck ✅ | 04-question-bank typecheck ✅ | pnpm eval:goldens-strict 75/75 ✅ | new tests: 11 inspect-attempt render + 18 cleanup + 12 email-send-flow + 18 MCP submit-questions + 14 generate-body-validation. testcontainers integration tests skipped locally (Docker-not-available baseline pattern, not regressions).

**Next:** Re-fire sharded smoke (count=15 L2) → use new per-chunk stderr_tail aggregation + inspect-attempt to diagnose the 2-chunk-fail mystery (log_analysis + scenario exit-1 on every smoke). Once root-caused, Stage 3 promotion design (in flight as `docs/design/2026-05-10-stage-3-promotion-rollout.md`) decides Option A (per-tenant flag column) vs Option B (global flip + auto-rollback cron) and execution begins.

**Open questions:**
- Why do log_analysis + scenario chunks consistently exit-1 across 4 smokes (`019e0d59`, `019e0da1`, `019e0deb`)? Pre-aggregation, stderr_tail was always NULL; next smoke will surface the actual reason.
- Stage 3 rollout shape — pending design-doc completion + user pick.
- Score-attempt web button (in flight) — closes last CLI-only gap for admins.

---

## Agent utilization
- Opus: Phase 0 reads, Phase 3 critique on every Sonnet diff, all deploy + smoke + DB ops, RCA + handoff authorship.
- Sonnet: Drove implementation across ~12 distinct prompts (Stage 1.5d/e/f, MCP schema, citation enforcement, stderr aggregation, generation-attempts history page, bulk archive UI, type-aware question view, invitation flow, candidate take audit, inspect-attempt CLI, cleanup CLIs, eval-fixture realignment, score-goldens CI gate, per-type grading audit). Phase 3 review caught 4 issues across the session: Stage 1.5d only landed HARD RULE on 1 of 5 skills (bounce-back), citation regex too soft (escalated to MCP gate), per-chunk stderr never reaching the row, eval fixtures had invented IDs (caught by score-candidate against attempt 019e0deb).
- Haiku: n/a — no bulk grep sweeps needed; investigation was concentrated in handler + runtime files.
- codex:rescue: n/a — companion MCP intentionally bypassed for Stage 1.5* work since structural+citation gates are now mechanical (Zod-enforced) rather than judgment-dependent. Adversarial review NOT needed for prompt-level → tool-level transitions.

---

## Stage 1.5+ artifacts (canonical references for next session)

- **`docs/design/2026-05-09-type-sharded-generation.md`** — parent architecture doc; 9 sections; all 9 open questions closed.
- **`docs/design/2026-05-10-stage-3-promotion-rollout.md`** (in flight) — Stage 3 rollout spec: gating criteria, per-tenant flag design, pilot tenant selection, rollout sequence, observability.
- **`modules/07-ai-grading/eval/runtime-baseline.json`** — single source of truth for runtime metrics + open known_gaps. Lines 56-64 list 6 RESOLVED and 1 OPEN gap (scenario chunk failed once, awaiting stderr dive).
- **`modules/07-ai-grading/eval/baseline.json`** — structural baseline; 75/75 across L1+L2+L3 across all 5 types.
- **`modules/07-ai-grading/eval/golden-questions/L{1,2,3}/{mcq,log_analysis,scenario,kql,subjective}.json`** — 75 reference questions.
- **`modules/07-ai-grading/eval/fixtures/L{1,2,3}-sources.json`** — KB source fixtures realigned to real `mitre.t*` IDs from `modules/04-question-bank/src/knowledge-base/soc-l*.json` (commit `cd352c7`).
- **`prompts/skills/generate-{mcq,log-analysis,scenario,kql,subjective}/SKILL.md`** — 5 type-shard skills at version `2026-05-09d`. Each contains a Question content shape (HARD RULE) + Source-citation contract (HARD RULE) — but both are now MECHANICALLY ENFORCED (MCP + handler) rather than load-bearing.
- **`prompts/skills/generate-rubric/SKILL.md`** — version `2026-05-08` (or `2026-05-10` if rubric audit prompt landed); see in-flight prompt for log_analysis support.
- **`tools/stage1-sharded-smoke.ts`** — fire smoke directly (count=15 L2 default). Bypasses HTTP/auth.
- **`tools/test-invite.ts`** — invite candidate via direct service call.
- **`tools/inspect-attempt.sh`** — VPS wrapper for inspect-attempt CLI.
- **`tools/cleanup-stale-drafts.ts`** + **`tools/cleanup-orphaned-attempts.ts`** — operator hygiene scripts; default --dry-run, --apply for writes; SET LOCAL ROLE assessiq_system for cross-tenant ops sweep.
- **`modules/07-ai-grading/eval/cli-typed.ts`** subcommands: `score-goldens` (CI gate, `pnpm eval:goldens-strict`), `write-baseline`, `diff-against-baseline`, `score-candidate --attempt-id <uuid>` (structural Zod parse + citation resolve + baseline diff; exit 0 pass / 1 regression / 2 error), `inspect-attempt --attempt-id <uuid> [--show-stderr] [--show-questions]` (diagnostic surface).

---

## Production state snapshot (2026-05-10 ~12:00 IST)

- VPS: `srv1150121.hstgr.cloud` (`72.61.227.64`); SSH alias `assessiq-vps`.
- All 5 containers healthy: postgres, redis, api (cmd: `pnpm exec tsx src/server.ts`), worker, frontend.
- VPS HEAD: matches origin/main `c979503` (last deploy this session).
- `/srv/assessiq/.env` `AI_GENERATE_MODE=omnibus` (default; sharded smoke flips this temporarily).
- 9 skills live at `~/.claude/skills/`: generate-questions (omnibus), generate-rubric, 5 type shards, 3 grading skills (anchors/band/escalate).
- assessiq-mcp: dist built on VPS, 4 tools registered (submit_anchors, submit_band, submit_questions, submit_rubric); strict per-type Zod schema enforced on submit_questions.
- API healthcheck: node fetch (replaced wget which was missing in node:22-slim, FailingStreak=1589 RCA).
- Migrations applied through 0043 (citation_dropped column on generation_attempts).
- 50+ ai_draft questions accumulated across 4 smoke runs on WIPRO-SOC L2 — admin can clean via bulk-archive UI or `cleanup-stale-drafts.ts`.

---



**Commits:** `cd352c7` — fix(grading): heartbeat 60s->5min, dismissible error banner, eval fixtures realigned to real KB IDs

**Tests:** pnpm -C modules/07-ai-grading typecheck ✅ | pnpm -C apps/api typecheck ✅ | pnpm -C modules/10-admin-dashboard typecheck ✅ | pnpm eval:goldens-strict: 75/75 passed ✅

**Next:** Deploy is not required (no API surface changes; eval and handler files are local). Next session can pick up Phase 2 work per `docs/plans/PHASE_2_KICKOFF.md`.

**Open questions:** none

---

## Agent utilization
- Opus: Drove entire session — planning, file edits, fixture replacements, verification
- Sonnet: n/a — all edits were ≤30 lines across ≤2-3 files, within Opus hot-cache
- Haiku: n/a — no bulk sweeps needed
- codex:rescue: n/a — no security/auth/classifier diffs; pre-flight confirmed companion MCP not needed

---

# Session — 2026-05-02 (Phase 2 Kickoff Plan authored)

**Headline:** `docs/plans/PHASE_2_KICKOFF.md` shipped — full Phase 2 plan for modules 07-ai-grading + 08-rubric-engine + 09-scoring + 10-admin-dashboard, mirroring Phase 1's structure: discovery summary, 18-row decisions table (D1–D8 verbatim from `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) + 10 new orchestrator-default resolutions P2.D9–P2.D18), G2.A → G2.B → G2.C session DAG with file paths, contracts, verification checklists, anti-pattern guards, four-step DoD per session.

**Commits this session:**

- `53a881e` — docs(plans): phase 2 kickoff plan

**Tests:** skipped — pure docs session, no code touched.

**Live verification:** N/A — pure docs, no deploy.

**Next:**

1. **Phase 1 G1.D closure** (in flight in a parallel window) — `11-candidate-ui` candidate-side `/take/*` flow staged uncommitted in this working tree (`modules/11-candidate-ui/{src,package.json,tsconfig.json,vitest.config.ts}` untracked from this Phase-2-plan session). G1.D's session lands its commit before G2.A opens to avoid the two windows racing on `apps/web/src/main.tsx` route registration.
2. **Phase 2 G2.A Session 1** — opens after G1.D lands. `modules/07-ai-grading` ships the D2 lint sentinel + `claude-code-vps` runtime + admin handlers (grade / accept / override / rerun / queue / claim / release / grading-jobs / budget) + eval harness skeleton + 3 in-repo skills (`prompts/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md`) + MCP server source at `tools/assessiq-mcp/` + admin Claude settings template at `infra/admin-claude-settings.example.json`. Migrations 0040 (gradings Phase 2 columns), 0041 (escalation_chosen_stage), 0042 (tenant_grading_budgets). **codex:rescue MANDATORY before push** per CLAUDE.md load-bearing-paths rule + the lint sentinel's own load-bearing-with-rescue-gate status.

**Open questions / explicit deferrals:**

- **None for the plan itself** — all 18 decisions captured at orchestrator-default. D1–D8 stay load-bearing per the user-confirmed `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) addendum. P2.D9–P2.D18 are new resolutions; if the user disagrees with any, the relevant session can re-open.
- **G1.D ↔ G2.A coordination** — Window α (G1.D) and the future Window for G2.A both write to `apps/web/src/main.tsx`. Coordinate commit windows so G1.D lands first; G2.A's frontend ship in G2.C Session 4 then layers on top. Not a Phase 2 plan-authoring concern, but an operational note for the next sessions.
- **Phase 2 deferrals listed in the plan's § Routing summary:** `runtimes/anthropic-api.ts` real implementation → Phase 3+; `runtimes/open-weights.ts` → Phase 4+; `prompt_versions` table population → Phase 3+; admin help-content WYSIWYG → Phase 3+ (Markdown-only ships in G2.C); public-facing leaderboard → Phase 3+ analytics module 15 with DPDP review; tenant-defined custom archetypes → Phase 3+; mobile admin UI → Phase 3+; `/admin/settings/audit` UI → Phase 3 (module 14); webhook config UI → Phase 3 (module 14); auto-retry on grading failures → Phase 3+ (BullMQ exponential backoff with `anthropic-api` mode); CSV bulk import → Phase 3+; `QuestionNavigator` UI primitive → Phase 3+ (`11-candidate-ui` polish); 19 of module 10's 26 SKILL.md pages → Phase 3+ (Phase 2 ships only the 7 grading/scoring/reports/help/billing-related pages).
- **Carry-over from prior sessions** (still open, not Phase-2-blocking): apps/web logger no-console violations + `pnpm exec eslint .` in CI; admin pages without kit reference screens (`mfa`, `users`, `invite-accept`); Spinner component in `@assessiq/ui-system`; MFA recovery code flow; HelpProvider localStorage tenant_id leak; `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` rename; root `eslint .` not in CI; SMTP driver swap-in for `tenants.smtp_config` JSONB column. All carried forward independent of Phase 2.

---

## Agent utilization

- **Opus:** Phase 0 warm-start reads (parallel: PROJECT_BRAIN, 01-architecture, prior SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF, PHASE_1_KICKOFF in two chunks for size, full 05-ai-pipeline.md including D1–D8 addendum). Synthesis of three Haiku discovery cluster reports into the single Phase 2 plan: dependency DAG, 18-row decisions table, four per-session blocks (G2.A Session 1 = 07; G2.B Sessions 2/3 = 08/09 parallel; G2.C Session 4 = 10), Final phase verification (12 drills), Routing summary, Appendix A (25 help_ids), Appendix B (G2.A operational migration recipe). Authored `docs/plans/PHASE_2_KICKOFF.md` end-to-end. Edited `PROJECT_BRAIN.md` decision log (one-line entry per the brief). Wrote this `docs/SESSION_STATE.md`.
- **Sonnet:** n/a — pure plan-authoring is judgment-heavy, not mechanical. The plan structure mirroring Phase 1 was Opus-direct because the substrate (PHASE_1_KICKOFF.md) was already in Opus's hot-cache window after the warm-start reads, and the synthesis required cross-referencing the three Haiku reports against the 8 D-decisions in 05-ai-pipeline.md — judgment work, not template-fill work.
- **Haiku:** 3 parallel discovery sweeps dispatched — Cluster A (07-ai-grading + AI-pipeline boundary), Cluster B (08-rubric-engine + 09-scoring), Cluster C (10-admin-dashboard + cross-cuts). Each agent reported per a strict reporting contract (consume / expose / copy-from-doc / gaps + confidence + line citations). All three returned high-quality structured reports inside the 1800-word budget; their outputs are the discovery substrate this plan rests on.
- **codex:rescue:** n/a — pure docs session; the plan itself does not touch security/auth/AI-classifier code. **G2.A Session 1 will require codex:rescue** when it ships the D2 lint sentinel + `claude-code-vps` runtime + admin handlers; that's the next session's obligation per CLAUDE.md load-bearing-paths rule.
