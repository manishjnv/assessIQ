# Pilot batch 7 (2026-10-02): eval golden set, NODE_ENV required, dependency majors

**Status:** LIVE on production (https://assessiq.in), deployed 2026-10-02 at `05beab3` (`c89b326..05beab3`).
**Deploy:** no migrations; api/worker/frontend rebuilt. Detail: `docs/06-deployment.md` § Batch 7 deploy. Adversarial review (Sonnet takeover): b7373af accept; 635f3fb revise then addressed in 05beab3; jose 0e30e4e accept; 99a5d57 accept; d5b0076 accept.

## What changed
- **N5 eval golden set (content, `635f3fb`, `05beab3`).** 150 AI-seeded cases (50 subjective, 50 scenario, 50 log_analysis; per type 9 at each band 0-4 plus 5 adversarial: injection, empty, off-topic, keyword stuffing, pasted question or logs). Questions come from the already-public golden-questions L1-L3; subjective rubrics authored per question (5 anchors); scenario and log_analysis rubrics computed with the real `resolveGradingRubric`. Each set was validated by a script (ids, anchors exist, evidence substrings present, bands, adversarial at most 1). Files live on the VPS only, in `eval/cases-private` (300 files, chmod 700). Compose bind-mounts that dir and `eval/runs` rw into `assessiq-api`. `.dockerignore` keeps both, and `eval/baselines/*.json`, out of images.
- **N9 (`635f3fb`).** `eval/cli.ts` honours `AIQ_EVAL_BASELINES_DIR` (empty = default), same rule as the gate.
- **N8 NODE_ENV required (`b7373af`).** No default in `modules/00-core/src/config.ts`; boot fails if unset. Prod `.env` and the api Dockerfile set it; vitest.setup sets `test`; `.env.example` has `development`. Host tools (`aiq-import-pack.ts`, `cleanup-*.ts`, `migrate.ts`) need `NODE_ENV` set.
- **Edit sections button (`92b3a8b`).** Removed (not disabled) unless the test is a draft with no attempts; the sections summary stays. Help text 0143 still says the button "is off once the test is published": accurate enough, not changed.
- **N7 dependency majors.** actions/checkout, setup-node, upload-artifact v7 and pnpm/action-setup v6 (`99a5d57`); minor/patch group PR #15 (`d5b0076`: @fastify/cookie 11.1.2, tsx, playwright 1.63, pg 8.23, typescript-eslint, etc.); jose 5 to 6.2.12 in 01-auth and 12-embed-sdk (`0e30e4e`: only test casts changed, verify options and caught error classes unchanged); React 19.3 (`cc17b5f`: `React.JSX.Element` in 25 files, `useRef` initial value in Try.tsx); apps/web Vite 8.3.2 (rolldown), plugin-react 6, vitest 4 (`000d2b9`: `manualChunks` became `rolldownOptions` codeSplitting groups). `05beab3` pins `build.target` to Vite 5's floor (es2020, edge88, firefox78, chrome87, safari14) because campus lab PCs run older browsers.

## Why
The gate approves nothing until a baseline exists, and the baseline needs a real golden set. Prod guards (test-minter refines) depended on one env value. Stale majors were piling up as Dependabot PRs.

## Considered and rejected
- **Committing the cases to git:** the repo is public; answers and rubrics would leak. VPS-only, like prompt skills (owner decision).
- **Storybook 10 now:** Storybook 8 supports Vite up to 6, so Storybook stays on Vite 5 until a Storybook 10 migration (N10).
- **argon2 0.45 now:** password hashing needs its own review (N10).
- **Keeping the Edit sections button disabled:** removed instead (owner decision).
- **Defaulting NODE_ENV:** a missing value must fail closed (owner decision).

## Not included
- argon2 0.45, Storybook 10, astro-og-canvas 0.13, canvaskit-wasm 0.42 (N10).
- The first bless and `AI_EVAL_GATE=enforce` (owner step).
- Expert verification of the cases: they are AI-seeded; claim "AI-assisted, consistency-tested", not expert-verified.
- Browser checks: Edit sections hidden on published; candidate pages under React 19 on an older Chrome.

## Downstream impact
- Host runs of tools need `NODE_ENV`. `git clean -fdx` on the VPS would delete the gitignored `cases-private`, `runs`, `baselines`: never run it.
- Open Dependabot PRs that overlap (#13 storybook part not taken, others) will auto-close or rebase.
- Web build is rolldown-based; bundle chunks are configured in `rolldownOptions`.

## How to verify on site
1. `/`, `/admin`, `/try`, `/api/health` return 200; a candidate page loads on an older Chrome (React 19, pinned target).
2. Admin: a published or started test shows no Edit sections button; a draft with no attempts still does.
3. Owner eval, inside the api container on the VPS: eval run, compare, bless (commands in `docs/06-deployment.md` § Batch 5 deploy). Check `run.json` `case_count` = 151 (150 + 1 sample). A full run grades about 151 cases through Claude Code on the Max login: expect a long run and subscription quota use.
4. Then set `AI_EVAL_GATE=enforce` in `/srv/assessiq/.env` and recreate `assessiq-api`; grading with the blessed prompts still works.
