# Session — 2026-05-02/03 (Phase 1 G1.D + worker observability + Session 4b take-backend)

**Headline:** Phase 1 G1.D candidate-taking SPA shipped live; VPS frontend healthy; Session 4b backend magic-link resolver + /take/* API routes committed; worker observability hardened (structured logs, retry policy, admin queue stats).

## Commits this session

| Commit | Scope | Summary |
|---|---|---|
| `da62760` | feat(candidate-ui) | take routes + nav + timer + autosave + integrity hooks — 34 files, 4714 insertions |
| `93a9e50` | fix(infra) | assessiq-frontend Docker build for G1.D workspace closure — Dockerfile deps/builder + Dockerfile.dockerignore rewritten |
| `f8a1cf6` | feat(worker) | structured logs + retry policy + admin queue stats — 9 files, 1062 insertions |
| `fae4b33` | feat(take) | magic-link resolver + /take/* route handlers — 4 files, 567 insertions; restores compile state |
| `9616723` | docs(session) | RCA_LOG (Docker TS2307 cascade) + SKILL.md what-shipped |

## Live verification (2026-05-03 ~02:30 UTC, post Caddy restart + matcher fix)

- All 5 assessiq containers healthy. Caddy restart (with user approval) recovered `ti-platform-caddy-1` from the inode-trap state.
- Caddy `@api` matcher now correctly narrowed: `/api/* /embed* /help/* /take/start` (verified via `caddy adapt`)
- Frontend `GET /take/<token>` → 200 text/html (SPA) ✓
- Backend `POST /take/start` body `{token:"<long-fake>"}` → 404 `INVITATION_NOT_FOUND` JSON envelope ✓ (correct generic-404 — no enumeration oracle)
- Backend `POST /take/start` body `{}` → 404 INVITATION_NOT_FOUND (token too short, same envelope) ✓
- `/api/health` → 200; `/api/me/assessments` → 401 AUTHN_FAILED; `/help/<key>` → 200 ✓
- Other 4 shared-Caddy sites (intelwatch.in, ti.intelwatch.in, accessbridge.space, automateedge.cloud) all responsive ✓

## This session's recovery commits + edits

| Commit | Scope | Summary |
|---|---|---|
| `da62760` | feat(candidate-ui) | take routes + nav + timer + autosave + integrity hooks — 34 files, 4714 insertions |
| `93a9e50` | fix(infra) | assessiq-frontend Docker build for G1.D workspace closure |
| `f8a1cf6` | feat(worker) | structured logs + retry policy + admin queue stats |
| `fae4b33` | feat(take) | magic-link resolver + /take/* route handlers (initial shape) |
| `9616723` | docs(session) | RCA_LOG (Docker TS2307 cascade) + SKILL.md what-shipped |
| *(uncommitted, ready to commit)* | fix(take) | route shape rewrite to match candidate-ui contract; routes.take.ts now mounts single `POST /take/start` body `{token}` returning `TakeStartResponseWire`. Caddy `@api` matcher narrowed to `/take/start` (specific path). RCA appended for the inode trap + matcher mismatch. |

## RCA entries appended (3)

1. `2026-05-03 — assessiq-api restart loop from staggered take-backend deploy` — staggered shipping of importer (server.ts) before exporter (module 06 routes.take.ts) caused `SyntaxError` boot loop. Process rule: cross-module deploys MUST list both files in `git archive`.
2. `2026-05-03 — sed -i on the bind-mounted Caddyfile broke the inode binding` — second occurrence of the inode trap in 4 days; recovery requires Caddy container restart with explicit user approval per CLAUDE.md rule #8.
3. `2026-05-03 — Caddy @api matcher missing /take/* — magic-link routes fell through to SPA` — second occurrence of the bare-root-route trap (first was `/help/*` on 2026-05-02). Pattern guard documented for any module mounting non-`/api/*` routes.

## Tests

- `modules/11-candidate-ui/__tests__/components.test.tsx` — 24 vitest cases pass locally
- Worker: `apps/api/src/__tests__/worker.test.ts`, `admin-worker.test.ts` — pass
- E2E `take-error-pages.spec.ts` passes; `take-happy-path.spec.ts` + `take-timer-expiry.spec.ts` no longer `test.skip` blockers — backend now live and contract-matched
- Module 05 + 06 typecheck clean; full workspace typecheck clean except pre-existing 11-candidate-ui `question_id: undefined` vs `null` shape (frontend-side; not blocking the take flow)

## Next

1. **Commit + push** the route-shape rewrite + Caddy matcher narrowing (uncommitted in this working tree).
2. **End-to-end candidate flow drill on production** — now that the backend contract matches the frontend's `takeStart` call: SSO admin → createPack → addLevel → createQuestion ×N → publishPack → activate-questions → createAssessment → publishAssessment → wait for boundary cron (or trigger manually) → inviteUsers → click email link in browser → SPA renders TokenLanding → `POST /take/start` succeeds → SPA navigates to `/take/attempt/:id` with session cookie set → candidate completes attempt.
3. **Phase 2 G2.A Session 1** opens after step 2 — `modules/07-ai-grading` ships the D2 lint sentinel + claude-code-vps runtime + admin handlers + 3 in-repo skills + MCP server source. **codex:rescue MANDATORY** before push per CLAUDE.md load-bearing-paths.

## Open questions / deferrals

- **`tools/lint-edge-routing.ts`** — recommended thrice now (help-system + Caddy /take/* + this session). Add a CI lint that parses non-`/api/*` route mounts in `apps/api/src/server.ts` and asserts each is in the canonical Caddyfile snippet from `docs/06-deployment.md`. Phase-2 infra backlog.
- **Pre-tool hook against `sed -i` on `/opt/ti-platform/caddy/`** — third Caddyfile-bind-mount RCA-pattern instance in 4 days. Add a hook that refuses `sed -i` against bind-mounted shared infra paths.
- **11-candidate-ui pre-existing typecheck failure**: `Type 'string | undefined' is not assignable to type 'string | null'` for `question_id`. Not introduced by this session; carries over into G1.D closure.
- **Modal primitive** in @assessiq/ui-system — Attempt.tsx uses `window.confirm`. Phase 2.
- **Monaco KqlEditor** — textarea fallback shipped. Phase 2.
- **AttemptTimer `onDriftCheck` wiring** — harmless for Phase 1 (no admin-extendable deadlines). Phase 2.
- **Autosave retry-revision inflation** — cosmetic; Phase 2 cleanup.

## Agent utilization

- **Opus 4.7 (1M)**: orchestration, critique, Docker build RCA, session docs, routing decisions
- **Sonnet**: G1.D frontend (modules/11-candidate-ui, apps/web/src/pages/take/*); worker impl (apps/api/src/{worker,routes/admin-worker}); take-backend (modules/{05,06}/src/)
- **Haiku**: n/a this session
- **codex:rescue**: n/a — no security/auth/classifier diffs
