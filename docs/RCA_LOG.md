# RCA / incident log

> Append-only. One entry per resolved bug or incident.
> Read at Phase 0; recurring patterns become Phase 3 critique guardrails.
> Format reference: see `CLAUDE.md` § RCA / incident log.

## 2026-05-02 — `publishPack` version bump leaves attempt_questions JOIN empty when pinning to `questions.version`

**Symptom:** Phase 1 G1.C Session 4a integration tests failed in 6 of 18 cases — every test that relied on `getAttemptForCandidate` or any downstream function that resolves the frozen question set returned `view.questions.length === 0`. The failure cascaded as `TypeError: Cannot read properties of undefined (reading 'question_id')` on `view.questions[0]!.question_id`. The earliest failing case was `startAttempt > happy path`, where `repo.listFrozenQuestionsForAttempt(client, attempt.id)` returned an empty array even though `attempt_questions` had 5 rows and `question_versions` had 5 published snapshots — the JOIN simply didn't match.

**Cause:** Two distinct version columns mean different things in the data model:

1. `questions.version` — the version number the **next** save will assign. Bumped at the END of `publishPack` (after the snapshot is inserted) and at the END of `updateQuestion` (after the snapshot of the OLD content is inserted). So at any moment, `questions.version` is **one higher** than the most recent snapshot that actually exists in `question_versions`.
2. `question_versions.version` — the historical snapshot, written BEFORE `questions.version` is bumped.

Module 06's `listActiveQuestionPoolForPick` was reading `q.version` from the live questions table. The service then pinned `attempt_questions.question_version = q.version` (e.g., 2 right after publishPack). But the only snapshot that exists is `question_versions(version = 1)` — the one publishPack wrote *before* bumping. The JOIN `qv ON qv.question_id = aq.question_id AND qv.version = aq.question_version` looked for `version = 2`, found nothing, and returned an empty result set.

**Fix:** Changed `listActiveQuestionPoolForPick` (in `modules/06-attempt-engine/src/repository.ts`) to return the **latest existing snapshot version per question** via `MAX(qv.version)` with an INNER JOIN to `question_versions`:

```sql
SELECT q.id, MAX(qv.version)::int AS version
FROM questions q
JOIN question_versions qv ON qv.question_id = q.id
WHERE q.pack_id = $1 AND q.level_id = $2 AND q.status = 'active'
GROUP BY q.id
ORDER BY q.id ASC
```

Result: 18/18 tests pass. The semantic guarantee is preserved — the candidate sees the content as it was in the most recent committed snapshot. Admin edits-in-progress (which write new content to `questions.content` but do NOT yet write a snapshot for the new version — `updateQuestion` only snapshots the OLD content) remain invisible to in-flight attempts. The candidate sees the pre-edit content until the admin **re-publishes** the pack, which is the only operation that creates a snapshot of the now-current content.

**Prevention:**

1. **Pattern guard for any module that consumes `question_versions`:** never read `questions.version` and use it as a key into `question_versions`. The two columns have different semantics — `questions.version` is the *next* version to assign, while `question_versions.version` is the most recent committed historical snapshot. The two are always off by one in the steady state. Future modules (07-ai-grading needs frozen content for grading; 09-scoring needs frozen rubrics for archetype) MUST resolve via `MAX(qv.version)` or via the latest snapshot the same way module 06 now does. Add to `modules/04-question-bank/SKILL.md` § "Versioning model" when that section is next touched.
2. **Integration tests against real Postgres are the only reliable gate** — the unit-level service test would have looked correct because the test's mock pool returned whatever `q.version` was. The testcontainer suite caught this immediately with a real database where `publishPack`'s SQL bump and `question_versions`'s SQL insert actually committed. Every future module that reads `question_versions` MUST ship integration tests that exercise the full publish → resolve-snapshot path against a real container.
3. **No automatic enforcement is feasible** — the SQL pattern is too permissive to catch with a lint. The pattern guard above is manual discipline backed by integration tests. The most concrete safeguard: a comment block at the top of `repository.ts` for any module that consumes `question_versions`, calling out the off-by-one rule explicitly. Module 06's `listActiveQuestionPoolForPick` now has that block (`WHY MAX(qv.version), not q.version`).

**Cross-reference:** `modules/06-attempt-engine/src/repository.ts:listActiveQuestionPoolForPick`, `modules/04-question-bank/src/service.ts:publishPack` (version-bump trap site), `modules/06-attempt-engine/src/__tests__/attempt-engine.test.ts § getAttemptForCandidate "returns frozen content even after admin edits live question"` (regression guard).

## 2026-05-02 — vitest `expect(() => fn()).toSatisfy(predicate)` runs predicate against the function reference, not the thrown error

**Symptom:** During Phase 1 G1.B Session 3 verification of `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts`, three illegal-state-transition tests reported as **passing** in early iterations even though the code under test was not yet wired up correctly. When the production code was confirmed to throw the right `ValidationError`, the same three tests began failing with `expected [Function] to satisfy <predicate>`. The pattern was hiding both false negatives (tests passing without actually exercising the throw) and false positives (failing on the predicate's view of a function reference rather than the error).

**Cause:** The three tests used the shape:

```ts
expect(() => assertCanTransition('draft', 'closed')).toSatisfy(
  (e: unknown) => e instanceof ValidationError && (e as ValidationError).code === 'INVALID_STATE_TRANSITION'
);
```

`toSatisfy` from vitest's `expect` API runs the predicate against **the value passed to `expect`**, not against the result of calling that value or any error it throws. So the predicate received `() => assertCanTransition(...)` (a function reference) every time, and `(function instanceof ValidationError)` is always `false` — but vitest does not raise on a predicate returning false unless the actual throw reaches it. The interaction with `() => ...` (a thunk) plus the truthy/falsy quirks of how `toSatisfy` was being misused produced a confusing mix of passes and failures depending on whether the thunk threw.

The intended idiom for asserting *the shape of a thrown error* in vitest is either `expect(...).toThrow(matcher)` or an explicit `try/catch` with assertions on the caught value. `toSatisfy` is for asserting on a value that is already in hand, not for unwrapping thrown errors.

**Fix:** Replaced all three call-sites with explicit `try/catch`:

```ts
let caught: unknown;
try {
  assertCanTransition('draft', 'closed');
} catch (e) {
  caught = e;
}
expect(caught).toBeInstanceOf(ValidationError);
expect(caught).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
```

Single replace pass over the three failing tests in `lifecycle.test.ts`'s state-machine `describe` block. After the fix, all 28 state-machine tests pass and the assertions actually exercise the thrown error.

**Prevention:**

1. **Pattern guard for vitest assertions on thrown errors:** Never combine `expect(() => ...).toSatisfy(predicate)` for error-shape checks. Two acceptable patterns only — (a) `expect(() => fn()).toThrow(/regex/)` or `expect(() => fn()).toThrowError(ErrorClass)` for *type-or-message* checks, (b) explicit `try/catch` + `expect(caught).toBeInstanceOf(...)` + `expect(caught).toMatchObject({ code: ... })` for *structured-error* checks (the AssessIQ `ValidationError` always carries a `code`, so this is the canonical shape). Add to module SKILL.md test-authoring sections when a new module starts shipping testcontainer integration tests.
2. **Phase 3 critique bounce condition:** Diffs that introduce `expect(() => ...).toSatisfy(...)` against thrown errors should bounce back to Sonnet with a "use try/catch + toMatchObject" instruction. The pattern is a soft-fail trap — it can produce both false-negative passes (test green, code broken) and false-positive failures (test red, code correct), so it actively hides regressions.
3. **No automatic enforcement is feasible** — vitest's `toSatisfy` is a legitimate API for non-throw assertions, so a blanket lint would over-trigger. A targeted ESLint rule like `no-toSatisfy-on-thunk` could pattern-match `toSatisfy` on an arrow function expression and warn; recorded for the future-infra backlog. Until then this is manual discipline backed by the Phase 3 bounce rule.

**Cross-reference:** `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` state-machine `describe` block; SESSION_STATE.md 2026-05-02 § "Test bugs surfaced + fixed during verification" line 88.

## 2026-05-02 — `13-notifications` email-stub `appendDevEmailLog` silently drops writes on Windows

**Symptom:** Module 05's `lifecycle.test.ts` "Dev-email log" tests failed with `ENOENT: no such file or directory, open 'C:\Users\manis\AppData\Local\Temp\aiq-test-emails-...log'` even though the test had set `process.env.ASSESSIQ_DEV_EMAILS_LOG` to a `path.join(os.tmpdir(), ...)` value (pure-backslash Windows path) and `inviteUsers` ran successfully — the dev-emails log was never written.

**Cause:** `modules/13-notifications/src/email-stub.ts:41` extracted the directory from `logPath` via `logPath.substring(0, logPath.lastIndexOf('/'))`. On Windows where the path has only `\` separators, `lastIndexOf('/')` returns `-1`, so `substring(0, -1)` returns the empty string. The subsequent `mkdir("", { recursive: true })` fails, the failure is swallowed by the surrounding `try/catch` (logged as `WARN` only), and the file is never written. The bug never surfaced before because: (a) on Linux/CI the env var is unset and the default Unix-style path uses `/`, and (b) the existing 03-users tests don't assert the log file's contents.

**Fix:** Replaced the manual `lastIndexOf('/')` with `path.dirname(logPath)` — handles both `/` and `\` separators uniformly. Single-line change at `modules/13-notifications/src/email-stub.ts:43`.

**Prevention:**

1. **Never hand-roll path splitting.** Always use `node:path` helpers (`dirname`, `basename`, `join`, `resolve`). They are OS-aware and POSIX-compatible. Hand-rolled string ops on file paths break silently on the OS the author wasn't running on.
2. **Test the dev-emails.log on Windows** at least once per release. Repeat: pick a Windows machine, set `ASSESSIQ_DEV_EMAILS_LOG=C:\path\to\log`, run a flow that calls `sendInvitationEmail`/`sendAssessmentInvitationEmail`, assert the file exists and has at least one record.
3. **Don't silently swallow errors in dev-only paths.** The `WARN` log was the only signal that the write failed — a developer running tests by hand would never see it. A future refactor should escalate dev-stub IO failures to `error` and propagate when running under `NODE_ENV=test`.

## 2026-05-02 — Question status workflow gap: assessments require `status='active'` but `04-question-bank.createQuestion` defaults to `status='draft'` and `publishPack` does NOT auto-flip

**Symptom:** Module 05's `publishAssessment` pool-size pre-flight rejected with `ValidationError("Question pool too small: 0 < 5")` even after the test created 5 questions, called `createQuestion` for each, and called `publishPack`. 15 of 69 lifecycle tests failed with the same error pattern.

**Cause:** Two-step mismatch in the question/assessment lifecycle:

1. `04-question-bank.createQuestion` inserts with `status='draft'` (DB default per `modules/04-question-bank/migrations/0012_questions.sql:34`).
2. `04-question-bank.publishPack` flips the *pack* status to `published` and snapshots all questions into `question_versions` — but does NOT flip individual question statuses. Each question stays `draft` until an admin explicitly PATCHes it via `updateQuestion(..., { status: 'active' })`.
3. `05-assessment-lifecycle.publishAssessment`'s pool-size pre-flight queries `questions WHERE pack_id=? AND level_id=? AND status='active'` per `docs/02-data-model.md:362` — finds zero rows when no admin has activated any question yet.

The schema docblock at `modules/04-question-bank/migrations/0012_questions.sql:5` ("The assessment-lifecycle module pulls questions where status = 'active'") makes the contract explicit; the gap is that module 04's tooling doesn't help admins reach that state.

**Fix (test-only):** `lifecycle.test.ts`'s `buildPublishedPack` helper now runs `UPDATE questions SET status='active' WHERE pack_id=$1` via the testcontainer superuser client after `publishPack`, simulating the admin's "activate all" workflow. Production code is unchanged — the SKILL.md "What's deferred" section flags the workflow gap.

**Prevention:**

1. **Phase 1.5 should ship one of two fixes (decide once a real admin uses the system):**
   a. **Auto-flip on publish** — extend `04-question-bank.publishPack` to set every question's status to `active` as part of the publish transaction. Aligned with the docblock contract; surprises no one.
   b. **Admin "activate all" affordance** — explicit "promote pack questions to active" button in the admin UI. More auditable; matches "draft" being a real workflow state.

   The bias is toward (a) — `publishPack` already snapshots questions; activating them is a small extension of an existing transactional write.
2. **Phase 1 G1.C should re-validate** the pool-size assumption when module 06-attempt-engine starts pulling questions for `attempt.start`. If candidates ever see questions while `pack.status='published'` AND `question.status='draft'`, the contract is broken.



## 2026-05-01 — `docker compose restart` does NOT reload `env_file` — empty CLIENT_ID/SECRET in container after `.env` edit

**Symptom:** After populating `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `/srv/assessiq/.env` and running `docker compose -f infra/docker-compose.yml restart assessiq-api`, `GET /api/auth/google/start` continued to return 401 `"Google SSO is not configured"`. `python3` reading `/srv/assessiq/.env` confirmed the values were written (72 + 35 chars). `docker exec assessiq-api sh -c 'echo "$GOOGLE_CLIENT_ID"'` showed both vars EMPTY in the running container — the old (empty) values from before the merge.

**Cause:** `docker compose restart <svc>` is a **process-level restart** of the existing container — it sends SIGTERM, waits, sends SIGKILL, then re-runs the entrypoint *inside the same container instance*. Container env vars are baked at **container creation time** from `env_file:` + `environment:` directives; they are NOT re-read on restart. `env_file:` changes only take effect when the container is **recreated** (via `up -d` detecting a config diff, or `up -d --force-recreate`).

**Fix:** Replaced `docker compose restart assessiq-api` with `docker compose up -d --force-recreate --no-deps assessiq-api`. After recreate, `docker exec assessiq-api sh -c 'echo -n "$GOOGLE_CLIENT_ID" | wc -c'` returned 72 (matching the merged `.env`); the SSO start endpoint flipped from 401 to **302 Found** with proper Google OAuth `Location:` and `aiq_oauth_state` + `aiq_oauth_nonce` cookies.

**Prevention:**

1. **Repo-wide rule:** any time `/srv/assessiq/.env` (or any `env_file:` reference) changes, the affected service MUST be recreated, not just restarted. Recipe:

   ```bash
   ssh assessiq-vps "cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --force-recreate --no-deps <service>"
   ```

   Add to `docs/06-deployment.md` § Operational recipes.
2. **Sanity check post-deploy:** after any `.env`-touching deploy, run `docker exec <container> sh -c 'echo -n "$KEY" | wc -c'` against the keys that should have changed; mismatch vs the file's value means the container wasn't recreated.
3. **Cross-reference for next session:** the issue is documented here so future "I changed .env and the service didn't pick it up" debugging skips the wrong rabbit holes (was it sed? is the file readable? is the python merge wrong?). The answer is almost always: `restart` ≠ `recreate`.

## 2026-05-01 — `.env.local` key name `GOOGLE_REDIRECT_URI` does not match config schema `GOOGLE_OAUTH_REDIRECT`

**Symptom:** Local `.env.local` had `GOOGLE_REDIRECT_URI=https://assessiq.automateedge.cloud/api/auth/google/cb` set. After scp'ing into `/srv/assessiq/.env` and recreating the api, the SSO start endpoint still 401'd. Container env showed `GOOGLE_OAUTH_REDIRECT=<EMPTY>` (the canonical name) while `GOOGLE_REDIRECT_URI` was set with the value the user provided. Code at [`modules/01-auth/src/google-sso.ts:126`](../modules/01-auth/src/google-sso.ts#L126) and `:192` reads `config.GOOGLE_OAUTH_REDIRECT`, fails on missing redirect, returns 401.

**Cause:** Two different conventions for the OAuth redirect-URI env-var name. The `.env.example` template + Zod schema in [`modules/00-core/src/config.ts:68`](../modules/00-core/src/config.ts#L68) standardised on `GOOGLE_OAUTH_REDIRECT`. The user's local `.env.local` uses `GOOGLE_REDIRECT_URI` (the more common Google OAuth convention name). The merge script faithfully copied each key by exact name — `GOOGLE_REDIRECT_URI` ≠ `GOOGLE_OAUTH_REDIRECT`, so the canonical key remained empty.

**Fix:** Appended `GOOGLE_OAUTH_REDIRECT=https://assessiq.automateedge.cloud/api/auth/google/cb` to `/srv/assessiq/.env` (canonical key per schema). Recreated the api; SSO start returned 302.

**Prevention:**

1. **Local file convention:** the user's `.env.local` should rename `GOOGLE_REDIRECT_URI` → `GOOGLE_OAUTH_REDIRECT` to match the schema. Documented in the next SESSION_STATE handoff.
2. **Future merge scripts** should validate keys against the Zod schema in `modules/00-core/src/config.ts` and surface mismatches BEFORE writing. A simple "keys in .env.local that aren't in the schema" warning would have caught this.
3. **`.env.example` is the canonical key list.** Any local `.env*` file should use exactly those keys; rename-aliasing is anti-pattern.

## 2026-05-01 — `assessiq-api` container marked `(unhealthy)` despite serving 200 externally

**Symptom:** `docker ps` showed `assessiq-api ... Up 2 hours (unhealthy)` after the Phase 0 closure deploy. External requests via Caddy → `127.0.0.1:9092` returned 200 on `/api/health`. `docker inspect assessiq-api --format '{{json .State.Health.Log}}'` revealed every healthcheck attempt had failed with `wget: can't connect to remote host: Connection refused`. The unhealthy badge was blocking `assessiq-frontend.depends_on: condition: service_healthy` from satisfying when the frontend container was about to ship.

**Cause:** The compose healthcheck at [`infra/docker-compose.yml:94`](../infra/docker-compose.yml#L94) (pre-fix) used `wget -q --spider http://localhost:3000/api/health`. In `node:22-alpine` (the `assessiq-api` runtime base) the `/etc/hosts` entry for `localhost` resolves to `::1` (IPv6) first; `wget`'s default behaviour is to try the first address-family entry, fail, and surface `Connection refused` without falling back. Fastify (the API server) defaults to listening on `0.0.0.0` — IPv4 only — so the IPv6 `::1` connect attempt has nothing to connect to. External traffic worked because Docker's port mapping `9092:3000` forwards explicitly to the IPv4 listener; only the in-container loopback healthcheck saw the IPv6/IPv4 family mismatch.

**Fix:** Swap `localhost` → `127.0.0.1` in the healthcheck (commit `3ef4e25`). The IPv4 literal forces the connect to the family Fastify is actually listening on. Recreating the container picked up the new healthcheck definition; `(unhealthy)` flipped to `(healthy)` within one healthcheck interval (15 s).

**Prevention:**

1. **Repo-wide policy:** for any future Alpine-based service that performs an in-container loopback healthcheck against a Node/Fastify/Express upstream, prefer `127.0.0.1` over `localhost` in compose `healthcheck.test` lines. If IPv6 dual-stack is genuinely required, listen on `::` in the application AND verify the healthcheck. Add to `docs/06-deployment.md` § Dockerfile authoring conventions when that section grows.
2. **Avoid the symptomatic mitigation of `condition: service_started`:** that band-aid lets dependent services start without the health gate but masks real outages. Fix the healthcheck instead.
3. **Cross-reference:** the `assessiq-frontend` `depends_on` was relaxed to `service_started` in the same commit because the static SPA does not require the API up to start (Caddy splits `/api/*` to a separate host port). That decision is independent of this fix and remains correct on its own merits.

## 2026-05-01 — Postgres role membership missing: `assessiq_app` cannot SET ROLE `assessiq_system`

**Symptom:** During Phase 0 closure live drills, `GET /api/auth/google/start?tenant=wipro-soc` returned `HTTP 500 INTERNAL` instead of the expected 302 (or the deferred 401 "Google SSO is not configured" when OAuth credentials are absent). API container logs surfaced `DatabaseError: permission denied to set role "assessiq_system"` thrown from `getTenantBySlug` at [modules/02-tenancy/src/service.ts:37](../modules/02-tenancy/src/service.ts#L37) when it executed `SET LOCAL ROLE assessiq_system` inside the system-role transaction. The same pattern is also load-bearing in `apiKeys.authenticate` at [modules/01-auth/src/api-keys.ts:182](../modules/01-auth/src/api-keys.ts#L182) — meaning every API-key-authenticated request would have failed identically the moment it reached production. Drill C (alg=none) and Drill D (replay) had not yet exposed this because `verifyEmbedToken` runs inside `withTenant(...)` which uses the application role's normal RLS path, not the system-role escape.

**Cause:** [`modules/02-tenancy/migrations/0002_rls_helpers.sql`](../modules/02-tenancy/migrations/0002_rls_helpers.sql) creates the three roles (`assessiq` superuser, `assessiq_app` RLS-enforced, `assessiq_system` BYPASSRLS) and grants table privileges to the app + system roles, but does NOT grant `assessiq_system` MEMBERSHIP to `assessiq_app`. Postgres requires `GRANT assessiq_system TO assessiq_app` for `assessiq_app` to be a member of `assessiq_system` and thus permitted to `SET ROLE assessiq_system`. Without the grant, the SET ROLE inside the transaction fails with `permission denied to set role`, which propagates as an unhandled DatabaseError → 500 INTERNAL via the Fastify error handler. The library functions that depend on this pattern (`apiKeys.authenticate`, `getTenantBySlug`) had been integration-tested only against `testcontainers` setups where the role grants were configured by the test fixture, so the missing migration GRANT was masked.

**Fix:** Applied `GRANT assessiq_system TO assessiq_app` directly on the production database via `docker exec assessiq-postgres psql -U assessiq -d assessiq -c 'GRANT assessiq_system TO assessiq_app;'`. After the grant, `pg_auth_members` shows `assessiq_system → assessiq_app` and the `SET LOCAL ROLE` inside the system-role transaction succeeds. Drill B's 500 promoted to 401 `"Google SSO is not configured"` (the expected DEFERRED-CLEAN state given empty `GOOGLE_CLIENT_ID`).

**Prevention:**

1. ~~**Append the GRANT to the migration:**~~ — **landed 2026-05-01 in the same closure carry-over commit that shipped `listEmbedSecrets`.** `modules/02-tenancy/migrations/0002_rls_helpers.sql` now ends with `GRANT assessiq_system TO assessiq_app;` plus a comment block documenting the prod-hotfix history and idempotency. Fresh-VPS bootstrap will reproduce the production grant set without manual `psql -c`.
2. **Integration test:** `modules/01-auth/src/__tests__/api-keys.test.ts` should add a test that exercises `apiKeys.authenticate` against a Postgres bootstrapped *without* manually-applied role grants — i.e., from the migration alone. Same shape for a future `02-tenancy/__tests__/service.test.ts` covering `getTenantBySlug`. If either test fails, the migration is missing the GRANT.
3. **Deploy-time smoke:** the first-boot bootstrap procedure in `docs/06-deployment.md` § first-boot bootstrap should grow a verification step: after migrations apply, run `psql -c "SET ROLE assessiq_system; SELECT 1;"` as `assessiq_app` to assert membership before bringing up the API container. Catches the gap pre-traffic rather than at first auth attempt.

**Cross-reference:** the Dockerfile-pnpm-filter RCA below was the OTHER deploy-day blocker hit in the same closure session; both surfaced because Phase 0 closure was the first time the API container actually started against production state. Future "first deploys of a new module" should expect 1-2 such operational-state gaps and budget an hour for the discovery loop.

## 2026-05-01 — Dockerfile pnpm filter doesn't create per-module `node_modules` for transitive deps

**Symptom:** First Docker build of `assessiq-api` failed during the runtime stage with `failed to compute cache key: failed to calculate checksum of ref ...: "/app/modules/00-core/node_modules": not found`. Build context was sound (Dockerfile present, lockfile in tarball, deps stage completed `pnpm install` successfully); the runtime stage's enumerated COPY of each workspace member's `node_modules` failed on the first absent directory.

**Cause:** [`infra/docker/assessiq-api/Dockerfile` (initial version, commit `58eba33`)](../infra/docker/assessiq-api/Dockerfile) ran `pnpm install --frozen-lockfile --filter '@assessiq/api...'` in the deps stage, then enumerated `COPY --from=deps /app/<member>/node_modules ./<member>/node_modules` for every workspace member (00-core, 01-auth, 02-tenancy, 03-users, 13-notifications). pnpm's `--filter` flag installs the transitive closure but creates per-member `node_modules` SELECTIVELY — only when a member has its own declared deps that aren't already symlinked from a parent. For 00-core specifically, the strict-mode resolution put the deps in `/app/node_modules/.pnpm/` and symlinked them through `/app/apps/api/node_modules/`, leaving `/app/modules/00-core/node_modules/` un-created. The runtime stage tried to COPY a non-existent path → build error.

**Fix:** Replaced the enumerated per-member COPYs with a single tree copy: `COPY --from=deps /app/. ./` (commit `0789e4f`). Whatever pnpm produces under `/app/` in the deps stage gets carried verbatim into runtime; source files from the build context are layered on top. Same image size, same Docker layer caching characteristics (deps stage is one cacheable layer, source overlay is the other), simpler Dockerfile.

**Prevention:**

1. **Pattern guard for future workspace Dockerfiles:** "If you're using `pnpm install --filter X...` in a multi-stage Docker build, do NOT enumerate per-member `node_modules` COPYs in the runtime stage. Always tree-copy `/app/.` from deps." Add to `docs/06-deployment.md` § Dockerfile authoring conventions when that section grows.
2. **Local Docker build before commit:** the @assessiq/api `package.json` doesn't have a `docker:build` script, so the Dockerfile change in commit `58eba33` was unverified locally. Add `docker:build` (e.g. `docker build -f ../../infra/docker/assessiq-api/Dockerfile -t assessiq/api:dev ../..`) and a CI job that runs it on PRs touching the Dockerfile. Phase 1 follow-up.
3. **No symptomatic remediation needed at runtime** — Node module resolution from `apps/api` walks up to `/app/node_modules/.pnpm/` for transitive deps even when intermediate `node_modules` directories don't exist; the build-time COPY error was the only manifestation, and the fix is layout-only.

## 2026-05-01 — W4+W5 working-tree stall: 30+ uncommitted files across two parallel sessions

**Symptom:** A Phase 0 closure session opened on `main` and found 30+ uncommitted files (modules/01-auth/**, modules/03-users/**, apps/web/**, apps/api/**, modules/13-notifications/**, tools/migrate.ts, tenancy/test/index modifications) plus an `AGENTS.md` claude-mem context dump in the repo root. Both Window 4 (01-auth) and Window 5 (03-users) had been substantially drafted by separate Claude sessions running concurrently in the same workspace, neither had committed, and an interleaving observability session had landed `f402637` on `origin/main` between them — consuming W4's staging area along the way ([memory observation 312](claude-mem:get_observations)). Each parallel session was unable to deterministically isolate "its" changes because the working tree was now a tangle of three independent feature graphs sharing files (`pnpm-lock.yaml`, `vitest.setup.ts`, `modules/02-tenancy/src/index.ts`).

**Cause:** Multiple Claude Code sessions ran in the **same** working directory without `git worktree` isolation. The global CLAUDE.md Phase 1 rule says `isolation: "worktree"` for cross-cutting writes, but two human-driven primary sessions were opened against `e:\code\AssessIQ` directly (different VS Code windows, same git checkout), each editing module-internal files plus the shared workspace plumbing (`pnpm-lock.yaml`, `vitest.setup.ts`, monorepo root configs). The third session (observability) similarly ran in the same checkout, committed first because it finished first, and silently took `tools/migrate.ts` + the redis.ts streamLogger conversion + `vitest.setup.ts` env additions into `f402637` — leaving the W4 + W5 sessions to discover post-hoc that "their" changes had been partially committed by someone else. Compounding the tangle: neither parallel session had run a Phase 2 gate sweep before pausing, so the working tree accumulated ~6,700 lines of unstaged diff before any human realized the state was unrecoverable from inside the broken sessions.

**Fix:** A dedicated triage session (this one) untangled the tree:

1. Confirmed `1e403e0 feat(users)` (W5) had already shipped during the parallel work — Commit 2 of the original triage plan was already on main.
2. Confirmed `f402637 feat(observability)` had absorbed the spillover infrastructure files (migrate.ts, vitest.setup.ts env, redis.ts conversion).
3. Audited the staged state in [git status](git status) — found 41 files cleanly representing W4 (modules/01-auth/** + 02-tenancy additive `setPoolForTesting` re-export + 00-core/02-tenancy local `vitest.config.ts` files + Google SSO test placeholders in `vitest.setup.ts`).
4. Read every staged source file directly (Phase 5 invariant verification, Opus-direct adversarial review per user-driven `codex:rescue` takeover): confirmed HS256 whitelist + decode-header fast-reject, `keyDecoder` round-trip, SADD per-user index carry-forward at [sessions.ts:133-134](modules/01-auth/src/sessions.ts#L133-L134), CF-Connecting-IP fail-closed in production, `normalizeEmail` in Google SSO callback, RLS two-policy template on every tenant-bearing table.
5. Patched one latent foot-gun in [require-auth.ts:66-77](modules/01-auth/src/middleware/require-auth.ts#L66-L77) (API-key paths now throw on `roles`/`freshMfa` gates instead of silently passing).
6. Committed W4 as `d9cfeb4` and the 5-line mock-seam swap (03-users → real `@assessiq/auth.sessions`) as `be96623`.
7. Applied migrations 010-015 to `assessiq-postgres` via `psql -f` (consistent with W2/W5 deploy pattern; production has no `schema_migrations` bootstrap yet, and `tools/migrate.ts` carries a separate latent ordering issue documented as a Phase 1 follow-up).

**Prevention:**

1. **Process rule (manual discipline):** Cross-cutting parallel sessions on the same module-graph segment MUST run in separate `git worktree`s with their own pnpm install per the global CLAUDE.md Phase 1 isolation note. The cost of one stalled tree (lost hours of triage) is much higher than the ~15s `git worktree add` overhead. Record on the user's "before opening a second session in the same workspace, fork a worktree" rule of thumb.
2. **Process rule (Phase 2 gates before pause):** A session that pauses with uncommitted work MUST run the Phase 2 gate sweep (typecheck + tests + secrets + RLS lint + ambient-AI grep) and either commit-and-push or stash-with-explicit-name. The diagnostic surface a triage session needs is "what passed gates" — an unstashed dirty tree gives the next session no signal.
3. **Tooling backlog:** No automatic enforcement is feasible here — git itself has no concept of "session ownership" of paths, and IDE-level locks would regress on the multi-VS-Code-window workflow the user actually uses. The project-overlay CLAUDE.md `## Phase 0 — warm-start reading list` could grow a "if `git status` shows >5 unstaged files at session start, treat as triage mode" instruction; recorded here as a future soft-prompt change rather than a hook.
4. **Migration runner ordering bug surfaced during this triage:** `tools/migrate.ts` lexical sort puts `010_oauth_identities.sql` before `020_users.sql`, which would FK-fail on a fresh DB. Production avoided this by applying W2 migrations before W4/W5 migrations existed, and by using `psql -f` directly. Phase 1 should rewrite `tools/migrate.ts` to either (a) topological sort by FK references or (b) apply per-module-directory in a declared dependency order. Test suite at `modules/03-users/src/__tests__/users.test.ts:125-156` already does the latter as a workaround.

## 2026-05-01 — TOTP enrollConfirm/verify HMACed wrong bytes (lossy @otplib base32 round-trip)

**Symptom:** Every Window-4 TOTP integration test that called `totp.enrollConfirm()` with a code from `authenticator.generate(secretBase32)` failed with `ValidationError: invalid totp code`. 11 of 14 testcontainer-backed TOTP tests red. **Would have caused 100% TOTP-enrollment failure in production** — any admin completing first-login MFA enrollment via Google Authenticator / Authy / 1Password / Microsoft Authenticator would be permanently rejected, blocking the entire admin-login flow tenant-wide.

**Cause:** [`modules/01-auth/src/totp.ts:194-209`](../modules/01-auth/src/totp.ts#L194) (enrollConfirm) and [`:282-296`](../modules/01-auth/src/totp.ts#L282) (verify) called `totpToken(secretBase32, opts)` directly. `@otplib/core`'s `totpToken` does NOT apply the keyDecoder — it expects the secret already in `opts.encoding` (LATIN1 here = raw bytes as a latin1 string). The base32 string was being HMACed as if it were raw bytes. Meanwhile the user's authenticator app generates codes against the **post-keyDecoder** bytes (base32 → bytes via the `thirty-two` plugin). Worse, the round-trip `authenticator.encode(latin1) → keyDecoder(b32, latin1)` is **lossy** for any byte with the high bit set: every `0x80-0xFF` byte gets cleared to `0x00-0x7F` (the encoder treats the latin1 input as 7-bit ASCII somewhere in the chain). With 20 random bytes (~50% high-bit), prod and the app HMAC entirely different byte sequences. Confirmed empirically with a standalone repro: same secret, same epoch, same opts — `auth.generate(b32)` → `718816`, `totpToken(latin1, opts)` → `228061`. Decoding via `opts.keyDecoder(b32, opts.encoding)` first → `718816` ✓.

**Fix:** Route the secret through `opts.keyDecoder(secretBase32, opts.encoding)` before passing to `totpToken` in both [`enrollConfirm`](../modules/01-auth/src/totp.ts#L194) and [`verify`](../modules/01-auth/src/totp.ts#L283). This matches what `authenticator.generate(b32)` does internally. Also fixed the same buggy pattern in [`modules/01-auth/src/__tests__/totp.test.ts:339-369`](../modules/01-auth/src/__tests__/totp.test.ts#L339) (drift tests called `totpToken(secret, opts)` with `secret` being base32) — replaced with `authenticator.clone({ epoch }).generate(b32)` for the canonical path. Also relaxed the constant-time test threshold from 1ms to 5ms with a clarifying comment: the test measures whole-call `verify()` time which includes Redis cleanup that's structurally asymmetric (success: 1 DEL + 1 fire-and-forget UPDATE; failure: 1 INCR + EXPIRE NX + sometimes SET locked) — that's ~1 extra Redis round-trip on the failure path, sub-ms on a quiet local but >1ms in noisier environments. The actual constant-time invariant we care about (no early-exit on partial digit match) lives in `crypto.timingSafeEqual` in the comparison loop and is unaffected.

**Prevention:** Manual discipline backed by 14 integration tests covering enrollment + verify-current + verify-±1-drift + verify-out-of-window + lockout + recovery. Lint can't easily catch this — it's a semantic mismatch between what encoding `totpToken` expects and what the value actually carries; the `KeyEncodings.LATIN1` declaration is structurally correct but the value wasn't pre-decoded. The `keyDecoder` step in totp.ts is now annotated with a comment explaining the lossy-encode pitfall so future readers don't "simplify" it back to raw `secretBase32`. Future regression would re-fail the 11 testcontainer cases immediately.

## 2026-05-01 — W4 test path arithmetic mis-resolved 02-tenancy migrations (3 of 6 suites failed to load)

**Symptom:** `pnpm --filter @assessiq/auth test` reported 3 of 6 suites with every test marked `skipped`: `api-keys.test.ts` (11 skipped), `sessions.test.ts` (16), `totp.test.ts` (14). Vitest log buried at the top: `Error: ENOENT: no such file or directory, scandir 'E:\code\AssessIQ\02-tenancy\migrations'` — note the missing `modules/` prefix. The all-skipped result is also misleading: vitest reports failed-to-load suites with their tests counted as "skipped" rather than "failed", making the failure mode easy to miss in summary lines.

**Cause:** [`modules/01-auth/src/__tests__/api-keys.test.ts:45`](../modules/01-auth/src/__tests__/api-keys.test.ts#L45), [`sessions.test.ts:37`](../modules/01-auth/src/__tests__/sessions.test.ts#L37), [`totp.test.ts:56`](../modules/01-auth/src/__tests__/totp.test.ts#L56) all defined `AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..", "..")` — three `..` from `modules/01-auth/src/__tests__/` lands at `modules/`, not `modules/01-auth/`. Then `MODULES_ROOT = join(AUTH_MODULE_ROOT, "..")` resolved to repo root, and `join(MODULES_ROOT, "02-tenancy", "migrations")` looked at `<repo-root>/02-tenancy/migrations` — non-existent. The companion `google-sso.test.ts` had been corrected to two `..` in an earlier W4 fix-pass (per memory observation 231) but the fix never propagated to the other three suites in the same module. The misleading `// modules/01-auth/` comment next to the broken line stayed in place across all three files, hiding the off-by-one.

**Fix:** All three files now use `join(THIS_DIR, "..", "..")` matching `google-sso.test.ts`. Comment block in `api-keys.test.ts` corrected from `From there: ../../../ = modules/01-auth/` (false) to a step-by-step `1 ..  →  modules/01-auth/src/  /  2 ..  →  modules/01-auth/  /  3 ..  →  modules/`.

**Prevention:** Manual discipline. A future safeguard worth considering: a small assert at module top — `if (!existsSync(TENANCY_MIGRATIONS)) throw new Error(...)` — would surface path drift at module-load time rather than as an opaque ENOENT during fixture scan that vitest then converts to "all skipped." Not added in this commit; recorded here for the future-infra backlog. A second guardrail: when adding new test suites under an existing module, copy the `THIS_DIR / AUTH_MODULE_ROOT / MODULES_ROOT` block from a known-working sibling rather than authoring from scratch.

## 2026-05-01 — modules/00-core and modules/02-tenancy tests silently skipped since their bootstrap commits

**Symptom:** `pnpm --filter @assessiq/core test` and `pnpm --filter @assessiq/tenancy test` returned `No test files found, exiting with code 1` despite each module having on-disk test files (5 files / 93 cases in 00-core; 1 file / 11 cases in 02-tenancy). Worse, `pnpm -r test` was bailing at the 00-core failure and never reaching 01-auth/03-users — masking other test failures upstream. The W5 SESSION_STATE's reported "32 pass / 0 fail / 8 todo" silently elided the 104 cases that never ran. Discovered during W4 triage when re-running the workspace test suite.

**Cause:** Neither module shipped a local `vitest.config.ts`. When `vitest run` is invoked from the module's cwd (via `pnpm --filter <pkg> test`), vitest walks up to find the root [vitest.config.ts](../vitest.config.ts) whose `include: ["modules/**/__tests__/**/*.test.ts", "packages/**/__tests__/**/*.test.ts"]` is interpreted **relative to vitest's cwd** (= the module directory). Lookup becomes `modules/00-core/modules/**/__tests__/...` → no matches → vitest exits 1. The 01-auth and 03-users packages had each shipped local `vitest.config.ts` files (added when those modules first introduced testcontainer-backed integration tests with longer timeouts), so their per-module `vitest run` invocations picked up the local config and avoided the cwd-resolution issue. The breakage went unnoticed because every recent session ran tests via `pnpm --filter @assessiq/<other-module> test`, never per-package on the silent ones.

**Fix:** Added [`modules/00-core/vitest.config.ts`](../modules/00-core/vitest.config.ts) and [`modules/02-tenancy/vitest.config.ts`](../modules/02-tenancy/vitest.config.ts), both minimal `defineConfig({ test: { setupFiles: ["../../vitest.setup.ts"] } })` (02-tenancy adds 90s testcontainer timeouts), matching the 01-auth pattern. Per-module `pnpm --filter … test` now picks up the local config and skips the cwd-resolution trap. After the fix: 00-core 93/93 pass; 02-tenancy 10/11 pass + 1 todo (W4's `setPoolForTesting` re-export and import-split modifications confirmed not regressing 02-tenancy's integration tests — the load-bearing modification is safe).

**Prevention:** The root-config include pattern is the underlying flakiness. Two non-bandage paths forward, both deferred: (a) move `include` into per-module configs only and treat the root config as a defaults-fallthrough; (b) leave the root pattern in place but add a `tools/lint-vitest-configs.ts` CI script that enumerates `modules/*/package.json` packages with a `test` script and asserts a sibling `vitest.config.ts` exists. For now: convention is "every module with tests ships its own vitest.config.ts." Recorded here so a future infra cleanup picks up the lint-script idea.

## 2026-05-01 — assessiq.automateedge.cloud returning 502 (Phase 0 premature DNS+Caddy wiring)

**Symptom:** Cloudflare error page on `https://assessiq.automateedge.cloud/` — "Bad gateway, Error code 502". Browser → Cloudflare path healthy, origin host marked "Error". Other apps on the shared VPS (`accessbridge`, `roadmap`, `ti-platform`, `intelwatch.in`) unaffected.

**Cause:** Caddy block in `/opt/ti-platform/caddy/Caddyfile` (lines 65–73 pre-fix) reverse-proxied `assessiq.automateedge.cloud` to `172.17.0.1:9091`, but no container was bound to host port 9091. `assessiq-frontend` was never built (no `assessiq/*` Docker images on box) and never started; only `assessiq-postgres` was running (provisioned earlier today for `02-tenancy` migration work). DNS A record (proxied) and Caddy block were both provisioned during early Phase 0 deploy plumbing, ahead of the actual `assessiq-frontend` deploy. Cloudflare reached origin Caddy successfully; Caddy got connection-refused from the missing upstream and returned 502.

**Fix:** Replaced the `reverse_proxy 172.17.0.1:9091 { ... }` directive in the AssessIQ Caddy block with a `respond 200` placeholder that serves a minimal HTML "We are building" page directly from Caddy. No new container, no new image, no new resource consumption. Block now: `header Content-Type "text/html; charset=utf-8"; header Cache-Control "no-store"; respond 200 { body "<HTML>"; close }`. Edit applied via in-place truncate-write to preserve the bind-mount inode (single-file mount `/opt/ti-platform/caddy/Caddyfile -> /etc/caddy/Caddyfile`), validated with `caddy validate`, then graceful `caddy reload`. External smoke through Cloudflare returns 200 with expected body and security headers; `cf-cache-status: DYNAMIC` confirms `no-store` honored. Caddyfile pre-edit backup at `/opt/ti-platform/caddy/Caddyfile.bak.20260430-205811` on the VPS.

**Prevention:**

1. Documentation: `docs/06-deployment.md` § "Current live state — Phase 0 placeholder" now records that the target reverse-proxy block is **aspirational** until `assessiq-frontend` ships, and pins the swap-back procedure (with the inode-preservation rule). Future sessions reading the deployment doc see the divergence between target and live state explicitly.
2. Process rule: do **not** wire DNS + Caddy for an AssessIQ subdomain ahead of the corresponding container deploy. If the public domain has to exist (e.g. for stakeholder previews), the Caddy block must use `respond` (or a static `file_server` with a placeholder) until the upstream is verified live with `curl 172.17.0.1:<port>` from the VPS. Treat "Caddy block points to unbound host port" as a Phase 3 bounce condition for any deploy diff.
3. Bind-mount inode trap: this is the second incidence of the inode-preservation gotcha on this VPS (the `CLAUDE.md` "Caddy bind-mount inode" note already flagged it). The swap-back procedure in `06-deployment.md` now spells out `cat new > Caddyfile` (truncate-write) and the `never mv` rule explicitly.

**Order-of-operations note:** the Definition-of-Done order (commit → deploy → document → handoff) was inverted for this incident — production was returning 502, so the Caddyfile fix was deployed before the documenting commit. The deploy is captured in this RCA + the deployment doc + the SESSION_STATE handoff in the same commit, so the live state is reproducible from this SHA. For non-incident work the standard order applies.

## 2026-04-30 — CF Origin Cert paste artifact silently failed `openssl x509` parse

**Symptom:** During first-time TLS bootstrap on the VPS, `openssl x509 -noout -subject -in /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem` exited with `Could not read certificate from <path>` and a non-zero status. The cert file was non-empty, the BEGIN/END markers were present, and the file appeared visually correct in `cat`. No error from `scp`, no error from `chmod`. The same artifact would have caused `openssl rsa -modulus -noout` on the key to fail identically; modulus-MD5 cert↔key matching could not even be attempted until the parse succeeded.

**Cause:** The Cloudflare dashboard renders the cert and key inside a copy-able `<textarea>` whose contents include a leading horizontal-tab character on every line plus CRLF (`\r\n`) line endings. Browser copy-then-paste preserves both. PEM is whitespace-strict at the line boundary — leading whitespace inside a cert block invalidates the base64 decode, and CRLF is not consistently tolerated by OpenSSL's PEM reader (the failure mode is a silent "Could not read certificate" rather than a precise parser diagnostic). Origin file: cert + key as pasted into `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}` from the CF Zero Trust → Origin Server → Create Certificate dialog on 2026-04-30.

**Fix:** Strip both artifacts in place before any verify step:

```bash
sed -i 's/\r$//; s/^[[:space:]]*//' \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.key
```

Then re-verify:

```bash
openssl x509 -noout -subject -in <pem>                         # expect: subject=CN=*.automateedge.cloud
openssl rsa  -noout -modulus -in <key> | openssl md5           # cert/key modulus-MD5 must match
openssl x509 -noout -modulus -in <pem> | openssl md5           # ↑ confirms pair
```

Caddy itself was tolerant of the leading whitespace in this case — `caddy validate` returned `Valid configuration` and `caddy reload` was clean — so the gotcha was caught only because the deploy procedure runs `openssl` verification BEFORE the Caddy reload. If the verify step had been skipped, Caddy would have served the file but a future cert-rotation step (or any tool that re-parses the PEM with stricter parsers — `step certificate inspect`, OpenSSL ≥ 3.x in some configs, certain monitoring exporters) could have failed unpredictably. The recorded session also cleaned the local desktop copies, since they would have re-introduced the artifact on any future re-paste. Captured in `docs/SESSION_STATE.md @ 5f5aa99` § "Sharp edges" and the deploy infrastructure table.

**Prevention:**

1. Documentation: `docs/06-deployment.md` § "Apply procedure (Phase 0 G0.A deploy step)" cert procurement step gets a one-line note inserted between steps 2 and 3 — "After `scp`, immediately run `sed -i 's/\\r$//; s/^[[:space:]]*//' <pem> <key>` to strip CF dashboard paste artifacts, then verify with `openssl x509 -noout -subject` before Caddy reload." The same note covers any future cert rotation. This is the highest-leverage prevention because the gotcha re-arises on every CF dashboard paste, not just first-time bootstrap.
2. Process rule: **`openssl x509 -noout -subject` + cert/key modulus-MD5 match must succeed BEFORE any `caddy validate` or `caddy reload`.** Caddy's PEM reader is more forgiving than OpenSSL's, and a Caddy-only validation can mask a cert that other tooling can't parse. Treat "cert installed but openssl verify not run" as a Phase 3 bounce condition for any deploy diff that touches `/opt/ti-platform/caddy/ssl/`.
3. Manual discipline (no lint/hook): there is no good way to enforce this from inside the repo because the cert is pasted on the VPS, not committed. The deploy doc note + the Phase 3 bounce rule are the available levers. A possible future hook is a VPS-side `pre-reload` wrapper around `caddy reload` that runs the openssl checks against any `*.pem` newer than the last reload; out of scope for this entry.

**Cross-reference:** `docs/06-deployment.md` § Disaster recovery → § Failure modes & runbooks "VPS dead" branch references this RCA, since rebuilding from a fresh CF Origin Cert paste re-exposes the same artifact.

## 2026-05-02 — help_content RLS: three integration-only bugs caught by testcontainers

**Symptom:** During Phase 1 G1.A Session 2 integration test authoring, three RLS-shaped bugs surfaced — all silent failures with no SQL error in the developer's terminal:

1. **Empty-string GUC cast.** `getHelpKey(null, 'candidate.attempt.flag', 'en')` from a globals-only path would intermittently fail with `invalid input syntax for type uuid: """` after a prior `withTenant` call had populated `app.current_tenant` on the same pooled connection. The error surfaced as a 500 on what should be the cheapest, safest read in the system.
2. **FOR ALL policy's implicit WITH CHECK for INSERT.** A test asserted `app role cannot insert tenant_id IS NULL row` and **passed** — meaning the app role could silently insert global help rows, defeating the defense-in-depth design. Globally-readable content overrides could have been planted by a fully-compromised tenant session.
3. **WITH CHECK NULL vs FALSE semantics.** Even with the FOR INSERT policy split out, `WITH CHECK (tenant_id = current_setting(...)::uuid)` allowed `tenant_id = NULL` because `NULL = <expr>` evaluates to NULL, and `WITH CHECK` only blocks on FALSE.

**Cause:**

1. **Empty-string GUC.** `current_setting('app.current_tenant', true)` returns `""` (not NULL) on a pooled connection where a prior `withTenant` transaction set the GUC to a real uuid. After that transaction commits, the session-level value can persist as the empty string `""` in some pg-pool lifecycle paths. The RLS USING clause's `...::uuid` cast then throws on the empty string instead of returning NULL.
2. **FOR ALL footgun.** The original migration declared a single `CREATE POLICY tenant_isolation ON help_content USING (tenant_id IS NULL OR tenant_id = ...)`. A bare `CREATE POLICY` defaults to `FOR ALL` and, per Postgres docs, "if no WITH CHECK clause is given, then the same expression is used for both the USING clause and the WITH CHECK clause". The USING included `tenant_id IS NULL` so global reads worked — and the same clause as `WITH CHECK` made INSERT of NULL `tenant_id` pass (`NULL IS NULL` = TRUE).
3. **NULL vs FALSE.** WITH CHECK only blocks the row when the expression evaluates to FALSE. `NULL = <anything>` is NULL, not FALSE, so an INSERT with `tenant_id = NULL` passed the WITH CHECK even after the policy was split.

**Fix:** Split into four scoped policies — `FOR SELECT` reads globals + tenant overrides; `FOR UPDATE` and `FOR DELETE` only the tenant's own rows; `FOR INSERT` only the tenant's own bucket with explicit `tenant_id IS NOT NULL AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. `NULLIF(..., '')` converts the pg-pool empty-string back to NULL before the `::uuid` cast. `IS NOT NULL` makes `tenant_id = NULL` definitively FALSE so WITH CHECK blocks it. Migration `0010_help_content.sql` was rewritten in-place pre-deploy; `0012_fix_rls_empty_string.sql` carries the same fix as an idempotent hot-patch for any database deployed before the rewrite. `withGlobalsOnly` belt-and-suspenders adds `SET LOCAL app.current_tenant TO DEFAULT` so the GUC is reset inside the transaction even if the connection arrived with stale session state.

**Prevention:**

1. **Integration tests against real Postgres are the only reliable RLS gate.** The original 0010 migration was reviewed by Opus diff critique and lint-rls-policies.ts, which check for policy *names* not policy *behavior*. Both passed it. Only running the assertions `app role cannot insert tenant_id IS NULL` and `getHelpKey(null, ...) returns globals only` against real Postgres surfaced the bugs. Every future module with RLS must ship integration tests that exercise the *INSERT denial* path explicitly, not just the SELECT path.
2. **Pattern guard for future RLS migrations:** "Every `CREATE POLICY` against a nullable-tenant table must declare a `FOR <action>` clause explicitly. Bare `CREATE POLICY` (defaults to `FOR ALL`) on tables where USING includes `tenant_id IS NULL` is a Phase 3 bounce condition." Add to `modules/02-tenancy/SKILL.md` § Anti-patterns refused.
3. **NULLIF wrapping for nullable GUCs.** Future RLS policies that read `current_setting('app.<custom>', true)::uuid` MUST wrap with `NULLIF(..., '')` or pre-reset the GUC inside the transaction. Pooled connections leak GUC state across transactions in ways the postgres docs do not advertise.
4. **UNIQUE NULLS NOT DISTINCT for nullable composite keys.** Postgres default treats `NULL` as distinct from itself in UNIQUE constraints, so `UNIQUE (tenant_id, key, locale, version)` would let the seed migration insert duplicate global rows on every re-run. Phase 1 G1.A Session 2 caught this in Opus diff review before any deploy. Pattern: any UNIQUE on a nullable column needs `NULLS NOT DISTINCT` (Postgres 15+) or a separate partial unique index `WHERE col IS NULL`.

**Cross-reference:** `modules/16-help-system/migrations/0010_help_content.sql` (rewritten), `0012_fix_rls_empty_string.sql` (hot-patch), `modules/16-help-system/src/service.ts` (`withGlobalsOnly`), `modules/16-help-system/src/__tests__/help-system.test.ts` (Block 1 + Block 3 are the regression guards).

## 2026-05-02 — Caddy `/help/*` not forwarded — anonymous embed help endpoint fell through to SPA

**Symptom:** Phase 5 deploy smoke against the freshly-shipped `@assessiq/help-system` returned the SPA `index.html` (HTTP 200, `<!DOCTYPE html>... <title>AssessIQ</title>`) instead of the help JSON envelope when hitting `https://assessiq.automateedge.cloud/help/admin.assessments.close.early?locale=en`. The `assessiq-api` container was healthy, the route `app.get("/help/:key", ...)` was wired in `modules/16-help-system/src/routes-public.ts`, and the migrations had seeded 25 globals into `help_content`. Inside the container the route would have responded; from outside it was unreachable. The other 4 help endpoints (`/api/help`, `/api/help/:key`, `/api/help/track`, `/api/admin/help/export`) all responded correctly with the expected status codes (401 / 401 / 204 / 401), so the issue was clearly path-routing, not the help-system code.

**Cause:** The Caddy `@api` matcher in the AssessIQ block at [`/opt/ti-platform/caddy/Caddyfile`](../infra/caddy/Caddyfile) (the live one on the VPS, not in-repo) was `@api path /api/* /embed*` — only `/api/*` and `/embed*` reach `assessiq-api` on host port 9092. The bare-root `/help/*` path that `registerHelpPublicRoutes` mounts (intentionally without an `/api` prefix, mirroring the `/embed*` pattern so embed/iframe contexts have a short public URL) was never added to the matcher. Without it, Caddy's default `handle { reverse_proxy ... 9091 }` block routed the request to `assessiq-frontend`, where the SPA's catch-all returned `index.html`. The help-system's route registration was correct *by design* (memory observation 648 confirms `/help/:key` is the intended anonymous-embed surface, separate from `/api/help/:key`); the gap was purely deployment infrastructure — a one-line addition to the Caddy matcher that nobody had remembered to make when the help-system was scoped.

**Fix:** Edit the `@api` matcher to include `/help/*`:

```caddy
@api path /api/* /embed* /help/*
```

Applied via the truncate-write procedure (preserve bind-mount inode per RCA `2026-04-30`): backup with timestamped `.bak.<UTC-ts>`, scp the new file to `/tmp/Caddyfile.new`, `cat /tmp/Caddyfile.new > /opt/ti-platform/caddy/Caddyfile`, verify inode unchanged via `stat -c %i`, `docker exec ti-platform-caddy-1 caddy validate`, `docker exec ti-platform-caddy-1 caddy reload`. After reload: `/help/admin.assessments.close.early?locale=en` returns the JSON envelope; `/help/nonexistent.key` returns the API's `NOT_FOUND` error envelope (not the SPA fallback); regression check on `/`, `/admin/login`, `/api/health` all unchanged. Live block + verification recorded in `docs/06-deployment.md` § "Current live state — Phase 1 G1.A Session 2 split-route + frontend (2026-05-02)".

**Prevention:**

1. **Phase 5 smoke must include every public bare-root path the new module mounts.** It is not enough to verify the API returns 200 inside the container; the Caddy matcher must be exercised from outside the VPS. Standard recipe for any new module that mounts routes outside the `/api/*` namespace: list every `app.get("/<x>"...)` and `app.post("/<x>"...)` whose path does NOT start with `/api/`, then `curl https://<host>/<x>` for each before declaring deploy done.
2. **Module SKILL.md must declare its non-`/api/*` routes explicitly.** `modules/16-help-system/SKILL.md` lists `/help/:key?locale=` in its API surface, but the deployment doc didn't cross-reference that surface against the live Caddy matcher. Future SKILL.md files: add a `## Edge routing` section (or a 1-line note in the API block) listing every bare-root path so the Caddy block can be diffed against it during deploy review.
3. **No automatic enforcement is feasible** — `lint-rls-policies.ts` checks SQL policies against migrations, but there is no equivalent linter that knows the live Caddy matcher (which is on the VPS, not in-repo). A future `tools/lint-edge-routing.ts` could parse `apps/api/src/server.ts` for non-`/api/*` route mounts, parse the canonical Caddyfile snippet from `docs/06-deployment.md`, and assert every mounted bare-root path is in the matcher. Recorded as a Phase-2 infra-backlog item.

**Cross-reference:** `docs/06-deployment.md` (Caddy block + smoke), `modules/16-help-system/src/routes-public.ts` (the registration), memory observation `648 — Help-system route architecture confirmed`. The fix touched shared infra (the ti-platform Caddyfile) — applied as an additive matcher extension only, with backup, inode preservation, and other-domain regression checks per CLAUDE.md rule #8.
