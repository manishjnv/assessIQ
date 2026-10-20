# Load test: about 500 students at once (candidate take flow)

*Type: how-to*

**Goal:** check that the take flow works for about 500 candidates who work at the same time. The script is `tools/load-test/take-flow.mjs`.

> [!WARNING]
> Do not run this against the production site. Do not pass `--i-am-sure-production` unless the owner approves the run in writing. The script refuses production hosts by default.

## Before you start

- Read the whole runbook once.
- Get the owner approval in section "Plan to show the owner before any production run".
- Use a test tenant only. Never use a tenant that a real school uses.
- Use Node 22 on the computer that runs the script. The script has no other dependencies.
- The VPS is shared with other apps. Ramp the load in steps. Never start all candidates at once.

## What the script hits

The script uses only these routes. No other route is part of the test.

| Method | Path | Label in results | What it does |
| --- | --- | --- | --- |
| `POST` | `/take/start` | `take.preview` | Reads the landing summary. Creates nothing. |
| `POST` | `/take/start` | `take.begin` | Begin click with `consent: true`. Creates the attempt and sets the `aiq_sess` cookie. |
| `GET` | `/api/me/attempts/:id` | `me.attempt.get` | Loads the questions and the timer. Runs once at start and every 6 answers. |
| `POST` | `/api/me/attempts/:id/answer` | `me.answer.save` | Autosaves one answer. Runs every 5 to 9 seconds for each candidate. |
| `POST` | `/api/me/attempts/:id/submit` | `me.attempt.submit` | Final submit when the candidate window ends. |

The script answers only `mcq` and `subjective` questions. Other question types are not answered.

No AI grading runs during the test. No one clicks grade. The submit step does not start grading.

## Set up the test tenant and test accounts

1. Ask the owner to create a test tenant. Name it with the prefix `loadtest-`. Use the super admin tools.
2. Sign in to the test tenant as its admin.
3. Create a draft assessment. Use a question pack that has enough active questions for the `question_count` you set. The API route is `POST /api/admin/assessments`.
4. Publish the assessment. The API route is `POST /api/admin/assessments/:id/publish`. The publish step fails with `422 POOL_TOO_SMALL` if the pool is too small.
5. Create the candidate accounts. Use a CSV with the header `name,email`, at most 1000 rows, at most 512 KB. Use `POST /api/admin/users/import` with the JSON body `{ "csv": "...", "assessment_id": "<id>" }`.
6. Invite the candidates. Use `POST /api/admin/assessments/:id/invite` with the body `{ "user_ids": [...], "delivery_mode": "mock" }`. Mock invitations skip the desktop and readiness gates. Read the note on email in section "Known limits".
7. Get the raw invitation tokens. Each token is the last part of the link `/take/<token>` in the invite email.

> [!WARNING]
> **Open item. Solve this before the run.** The API stores only a hash of each invitation token. No API returns the raw token, so there is no supported way to get 500 tokens today. The owner must choose one of these:
> - A test-only token export on the test server. This needs a code change and owner approval.
> - Test mailboxes that the owner can read. Copy the token from each invite email.

8. Save the tokens in a text file. Put one token on each line. Lines that start with `#` are skipped. The script refuses duplicate tokens.
9. Make a second, separate file for the warm-up run. Use at least 50 tokens. The two sets must not overlap. Each invitation works once. A token that was used in an earlier run returns `410`.
10. Run the dry run. It sends no request:

```
node tools/load-test/take-flow.mjs --base-url <test-url> --tokens <tokens-file> --concurrency 500 --dry-run
```

Expected result: the script prints the plan and the number of tokens it found. It exits with code 0.

## Run the test

1. Confirm the owner approval. Confirm that the base URL host is the one in the approval.
2. Confirm that someone watches the server during the run. See section "What to watch on the server".
3. Run the warm-up first. Use 50 candidates, a ramp of 60 seconds and a window of 300 seconds:

```
node tools/load-test/take-flow.mjs --base-url <test-url> --tokens <warmup-tokens-file> --concurrency 50 --ramp-seconds 60 --duration-seconds 300 --max-requests 20000
```

4. Read the warm-up result. If a stop limit fired, do not start the main run. Fix the cause first.
5. Wait at least 10 minutes. Let the server return to normal. Check `docker stats`.
6. Run the main test. Use 500 candidates, a ramp of 600 seconds and a window of 1800 seconds:

```
node tools/load-test/take-flow.mjs --base-url <test-url> --tokens <main-tokens-file> --concurrency 500 --ramp-seconds 600 --duration-seconds 1800 --max-requests 200000
```

7. Press Ctrl+C if the server shows trouble. The script prints the reason and writes the JSON file.
8. Save the output. The JSON file is in `tools/load-test/out/`. That folder is gitignored.

## Expected duration

- Warm-up: about 7 minutes.
- Main run: about 43 minutes. That is 10 minutes of ramp, 30 minutes of window and a short submit step.
- Plan one hour with the checks before and after the run.

## Stop limits

The script aborts all candidates when one of these limits fires. It prints the reason. The exit code is `4`.

- **Error rate:** more than 2 percent of requests are 5xx or network errors, over any 30 second window. The window needs at least 20 requests.
- **Latency:** the p95 latency is above 5 seconds for 30 seconds.
- **Request cap:** the total number of requests reaches `--max-requests` (default 50000).

Other behaviour:

- Ctrl+C stops the run with the reason `interrupted by operator`.
- A `429` response does not stop the run. A `429` is a rate limit, not an error. The table shows the count.
- A stopped run leaves candidate attempts open. Use section "Clean up".

## Read the results

The script prints one row for each route. The columns are:

- `count`: requests sent for that route.
- `p50 ms`, `p95 ms`, `p99 ms`: response time percentiles.
- `5xx+net`: 5xx responses and network errors.
- `statuses`: count for each HTTP status.

The footer shows requests per second, the number of `429` responses and the candidates that began and submitted. The stop reason is the last line.

The owner sets the pass targets before the run. The script has no targets. Write the targets in the plan before you start.

Check these items after the run:

- Compare `failed to begin` with the token count. Each failure needs a reason.
- Every `take.begin` returns `201`.
- Most submits return `2xx`.
- No 5xx responses appear in the API log.

## What to watch on the server

Run these commands on the VPS during the run. Use the SSH alias `assessiq-vps`. Change nothing during the run.

- Container load: `docker stats --no-stream assessiq-api assessiq-worker assessiq-postgres assessiq-redis`
- API errors: `docker logs --tail 200 assessiq-api`
- Database connections: `docker exec assessiq-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from pg_stat_activity;"'`
- Redis clients: `docker exec assessiq-redis redis-cli info clients`
- Disk: `df -h /`

Watch for these signs:

- The API container memory keeps going up.
- The database connection count reaches the pool limit and stays there.
- Redis memory or client count rises without a fall.
- Other apps on the VPS slow down.

If another app on the VPS slows down, stop the run at once.

## Clean up

1. Check that the run has ended. Check that no `take-flow.mjs` process runs.
2. Ask the owner to archive the test tenant with the super admin lifecycle route `POST /api/admin/super/tenants/:tenantId/archive`.
3. Delete or keep the token files as the owner decides. Do not commit them. They are secrets for the test tenant.
4. Check the open attempts. Read the header of `tools/cleanup-orphaned-attempts.ts` before you run it on the test tenant.
5. Save the JSON results for the owner. Do not commit them.

## Roll back

The script changes no code and no configuration. To stop a run:

1. Press Ctrl+C in the terminal that runs the script.
2. Check `docker stats` and the API log.
3. If the API is down, follow the code rollback in `docs/06-deployment.md` section "Roll back and stage". Use the last good SHA. Do not change the database.

## Known limits

- **One IP for all candidates.** The script runs from one computer, so all requests share one IP. The server limits requests per IP. The default limit for a candidate session is 3000 requests per minute per IP. That is about 50 requests per second. Above that, the server returns `429`. The `429` count in the table shows this limit. A true 500 student load needs load from several IPs. The script cannot do that yet.
- **Email limit.** Invitation emails count against the daily bulk email cap. The default cap is 250 a day (`EMAIL_BULK_DAILY_CAP`). A 500 invite run is above that cap on one day. The owner must choose: raise the cap for the test tenant, or split the invites over two days.
- **Real and mock.** A real invitation needs a desktop browser and a readiness check. The script sends both, but the readiness values are fixed. The owner decides if the test uses mock invitations.
- **Tokens.** See the open item in section "Set up the test tenant and test accounts".

## Plan to show the owner before any production run

Show this section to the owner before any run that uses the production host. Do not start until the owner signs off.

- **What it hits:** the five routes in section "What the script hits". The test tenant only. No other tenant, no admin pages, no grading.
- **How long:** warm-up with 50 candidates for about 7 minutes. Main run with 500 candidates for about 43 minutes. Run in an off-peak window that the owner agrees.
- **Ramp:** warm-up ramp 60 seconds. Main ramp 600 seconds. Wait 10 minutes between the warm-up and the main run.
- **Stop limits:** error rate above 2 percent over 30 seconds, p95 above 5 seconds for 30 seconds, and the request cap (`--max-requests`). The owner sets the request cap value.
- **Who watches:** name the person who watches the server and the person who can press Ctrl+C.
- **Shared VPS:** the VPS runs other apps. Stop the run if another app slows down.
- **Targets:** the owner writes the pass targets here before the run: ____________.
- **Owner approval:** ____________ (name and date). Without this line, do not run.
