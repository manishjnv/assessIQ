# Pilot batch 6 (2026-10-02): CI green, dependency bumps, section editor, test-minter guard

**Status:** LIVE on production (https://assessiq.in), deployed 2026-10-02 at `c214ef1` (`c1583a6..c214ef1`).
**Deploy:** migration 0143 by hand; api/worker/frontend rebuilt. Detail: `docs/06-deployment.md` § Batch 6 deploy. Adversarial review (Sonnet takeover): 4b73057 revise then addressed, E5 revise then addressed, N4 accept.

## What changed
- **CI fix (`4b73057`, `2c66be6`).** CI had been red since `c1583a6`: two env vars were not declared in `.env.example` and a comment contained "FIXME". Fixed; run 36994877726 is green. Review found `baselinesDir()` used `??`, so the new empty `AIQ_EVAL_BASELINES_DIR=` line broke the gate; now `||`.
- **E5 test-minter guard (`6589d72`, `9a89654`).** `ENABLE_EMBED_TEST_MINTER` is declared in 00-core config with a production refine (boot fails if on), like `ENABLE_E2E_TEST_MINTER`. CI greps tracked templates, compose files and Dockerfiles for either flag set true/1 (also `${VAR:-true}`). Blank flag lines count as unset.
- **N6 section editor (`9ea5aca`, `37d5347`).** SectionsCard on the admin assessment page reuses SectionsEditor/buildSections and saves through the existing `PATCH /api/admin/assessments/:id`. Draft only; 409 `SECTIONS_LOCKED` after any attempt. The button is disabled with a tooltip when locked; the 409 shows inline. Help id `admin.assessment.sections.edit`, migration 0143. It re-reads the assessment before the PATCH because the PATCH replaces settings wholesale.
- **N4 dependency bumps (`c214ef1`).** fastify ^5.12.2 (5.12.5) in 12 packages, nodemailer ^10.0.6 (10.0.13) + @types/nodemailer ^8 in 13-notifications, root override `fast-uri@3 ^3.1.8`, find-my-way 9.9.0. `pnpm audit --prod`: 17 high to 0 high/critical (5 moderate left: react-router, react-router-dom, @remix-run/router, fast-uri).

## Why
Red CI hid real regressions; the 17 high advisories were the biggest supply-chain gap; admins could not fix sections after creating an assessment; a test-only login must be provably off in prod.

## Considered and rejected
- **Taking Dependabot majors** (vite 8, jose 6, react, GitHub actions v4 to 6/7): breaking, and jose is auth. Left as N7.
- **A new sections route:** the existing PATCH already enforces draft-only and the lock; no new API surface.
- **Requiring NODE_ENV:** it defaults to development when unset, so the prod refines would not fire; only the api Dockerfile `ENV NODE_ENV=production` protects prod (prod `.env` also sets it). Hardening is the owner's call (N8).
- **Making `embed.ts` read config:** it still reads `process.env === '1'` directly (fail-safe; config throws first in prod).

## Not included
N5 eval golden set (held: the owner asked whether new cases may live in the PUBLIC repo; recommendation is VPS-only, like prompt skills); N7 Dependabot majors; N8 NODE_ENV hardening; N9 `eval/cli.ts` honouring `AIQ_EVAL_BASELINES_DIR`; the 5 moderate advisories.

## Downstream impact
- 13-notifications runs nodemailer 10 (Node 20+, stricter TLS for remote content, NoAuth becomes ENOAUTH); our `createTransport(url)` + `sendMail` use is unaffected; SMTP verify passed against Brevo.
- All fastify apps use 5.12.x. 00-core config gains a flag; 10-admin-dashboard and 16-help-system change (175 rows in seed, 182 live); CI gains a quality step.

## How to verify on site
1. Admin: draft assessment, Edit sections, change, save; reload and see the change; the other cards (integrity, high-stakes, reminders) keep their values.
2. Publish it or start an attempt: the Edit sections button is disabled with a tooltip.
3. `/api/health`, `/try`, `/admin` return 200; an invite email still sends.
4. GitHub CI on main is green.
