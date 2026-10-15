# Review wave 2 — record (2026-10-03, session q)

**Status:** on `main`. Wave A (`7e2af3d`) is live. Wave B (`ef01da2`, migration 0155) is deployed. Marketing is not rebuilt.

## What shipped
| Item | Commits | Summary |
|---|---|---|
| RS10 (RV69, RV70, RV72, RV75) | `e645d81` | CI: hooks lint, web tests, MV tenant lint, config keys vs `.env.example`. Fixed CI red since `6d6c6bd` (`E2E_API_PROXY`). |
| FR2 FU-B5, FU-B8 | `9a111e1` | `withTenant` `onCommit`; `auditInTx` events reach webhooks after commit. Integration guide corrected. |
| FR4 FU-B12 | `eafeeac`, `7e2af3d` | Embed JIT insert uses real columns; case-insensitive; every variant must be an active candidate. |
| FR13 FU-C12 | `6638494` | Completion modal on new certificates. |
| FR25 FU-C16 | `b5fa76a` | One rubric parser (module 08). |
| RS4 (RV24 to RV28) | `9b541ba` | Marketing text fixes. Code only. |
| N23 | `4ad6cc0` | 30 help ids renamed, migration 0155. |
| N25 | `00a951e` | 404 `<main>` landmark. |
| N26 | `f1c0aa0` | Reviewer leftovers; HTTP tests. |
| N24 | `34abc0e`, `c58438a`, `9b585a7` | One AES core, one fixed-window Lua script. |

## Reviews
- RS10: Sonnet accept.
- FR2: codex accept.
- FR4: codex revise (mixed-case admin HIGH), addressed in `7e2af3d`.
- N24: codex accept.

## Deploys
- Wave A: `7e2af3d`, no migration, api, worker, frontend. Healthy, 8 routes OK.
- Wave B: `ef01da2`, migration 0155, api, worker, frontend. Result in `docs/SESSION_STATE.md` and `docs/06-deployment.md`.

## Tests
Modules 2556 of 2557 (only failure: `totp.test.ts` timing flake, pre-existing). apps/api 138. apps/web 73. Typecheck 0. Lint 0 errors, 20 warnings. CI green on `e645d81` and `7e2af3d`.

## Open items
- RS4: the owner approves the text (RV28 privacy drafts, CSV wording; competitor figures removed in `ac39f6e`). Then rebuild `assessiq-marketing` and send the IndexNow ping.
- RS10: RV68 (N3, owner approval), RV71, RV73, RV74 are open.
- RS7 follow-ups: FU-B6 business events (owner picks the list), FU-B7 webhook screen, FU-B13 embed iframe and Caddy `frame-ancestors`, FU-B14, FU-B15, FU-C17, FU-C18 (codex gate), FU-C19.
- `tenant_settings.webhook_secret` is write-only: keep or remove?
- Browser click checks stay with the owner.

## Rules honored
Rule A (no deletion of dormant features; `reviewer` stays in DB CHECKs). Rule B (old task checked: RV75 extended CHECK C; FR2 reused `fanoutAuditEvent`; N24 kept wrapper names; FR13 revived `CompletionModal`; FR25 kept `parseRubric`).
