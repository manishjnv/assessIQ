# X4 — Grade KQL answers by running the query (design note)

Status: design only. Nothing is built. Date: 2026-10-02.

## 1. Goal and why

Score a KQL answer by running it against a small fixed dataset and comparing the result to the result of the reference query. The score is deterministic and easy to explain ("your query returned 4 rows, we expected 5"). It uses no AI call.

Current state, as found in code:
- KQL has **no grader today**. The AI batch skips it: `modules/07-ai-grading/src/handlers/admin-grade.ts:78-80` and `:439` ("KQL has no grader yet (known gap)").
- A human must give the first score: `modules/07-ai-grading/src/handlers/admin-manual-score.ts:5` and `routes-super.ts:307`.
- The attempt cannot finish until every KQL question is scored: `handlers/admin-accept.ts:73-78`.
- The content schema holds `question`, `tables[]`, `hint`, `expected_keywords[]`, `sample_solution` (`modules/04-question-bank/src/types.ts:85-91`). The `expected_keywords` are authoring data only. No code scores with them.
- So option (d), "keep the current approach", means "keep manual scoring". It is not keyword match plus AI.

Why now: each KQL question costs the owner a manual score. Deterministic MCQ scoring already exists and is the model to copy (`modules/09-scoring/src/mcq.ts:1-14`, exports at `modules/09-scoring/src/index.ts:54-66`).

## 2. Options

### (a) Kusto emulator container, `assessiq-kusto`
Image `mcr.microsoft.com/azuredataexplorer/kustainer-linux`. Real KQL semantics.
- Isolation: own container, `assessiq-` prefix, internal Docker network only, no published port, no internet egress. Only the API container can reach it.
- Cost: no licence fee for the emulator (check the EULA before launch). Resource cost is real: plan on about 2 GB RAM minimum and 1 vCPU while a query runs. Measure the idle and peak figures before any decision. Set `mem_limit` and `cpus` in compose.
- Effort: medium. A client call, dataset loader, comparer, tests. About 1 to 2 weeks.
- Risk: the shared VPS runs other companies' apps (`docs/06-deployment.md:7`, and `CLAUDE.md` rule 8). A memory spike must not hurt neighbours. The emulator is a large Microsoft image. Its patch cadence is our job. Some KQL features may be missing in the emulator.

### (b) KQL-to-SQL translator on Postgres sample tables
- Isolation: needs a read-only Postgres role and schema. No new container.
- Cost: low RAM.
- Effort: high and never done. KQL is a pipe language. A translator covers only a subset (`where`, `project`, `summarize`, `join`). Real answers use `parse`, `extend`, `make-series`, `mv-expand`.
- Risk: wrong results. A correct answer scored wrong is worse than a manual score. Reject for now.

### (c) Hosted ADX cluster per tenant
- Isolation: strong, but data and billing cross our trust boundary.
- Cost: highest. Paid cluster per tenant, always on. The app is free (memory: scoring-release rules), so this does not fit.
- Effort: medium plus provisioning and credential handling.
- Risk: secrets per tenant; internet egress. Reject.

### (d) Keep the current approach (manual score)
- Zero new risk, zero effort. Owner time per KQL question stays. Acceptable while KQL is 5 to 20 percent of a test (`modules/10-admin-dashboard/src/auto-weight.ts:22-24`).

## 3. Scoring model (for option a)

1. Run the candidate query and the `sample_solution` query on the same dataset.
2. Compare result sets: same column names (case-sensitive) and the same rows.
3. Rows are compared as an unordered multiset. If the question sets `ordered: true` (a `sort`/`top` task), compare in order.
4. Float values use a small tolerance. Dates are compared in ISO form.
5. Map to the existing bands 0/25/50/75/100. Example: exact match = 100; right rows, extra or missing columns = 75; right columns, over 50 percent of rows = 50; runs but wrong = 25; error or timeout = 0. Band scoring is a project rule (`CLAUDE.md` rule 4).
6. Store the diff (expected rows vs got rows, capped) as the explanation. Admin override stays possible, as for MCQ.
- Limits: 5 s time limit per query; 1000 row cap per result; 64 KB query length.
- Datasets: read-only, loaded once per question pack at publish time. No tenant data in the sandbox.

## 4. Security

- Threat: a candidate controls the query text. Wants to read other data, exhaust the host, or reach the network.
- Controls: ADX restricted-viewer policy and a single database per dataset; query timeout; row and memory caps; block management commands (anything starting with `.`); block `externaldata`, `http_request`, `evaluate` plugins; deny all egress at the network layer; no volume mounts of host paths.
- The sandbox holds only authored dataset rows. Never candidate PII, never tenant rows.
- Who triggers it: at candidate submit would be fine. The "no ambient / no candidate-triggered" rule covers **AI** calls only (`docs/05-ai-pipeline.md:31` and the `lint-no-ambient-claude.ts` contract at `:514`). Executing KQL is not an AI call. MCQ already scores at submit (`modules/09-scoring/src/index.ts:54`). Still, protect the box: run the grading in a queue worker with concurrency 1 to 2, not inside the request. The lint must stay clean, so the worker must not import the grading runtime. Keep the code in `modules/09-scoring`, outside `07-ai-grading`.

## 5. What must change

- Content schema (`types.ts:85`): add `dataset_id` (ref to a dataset in the pack), `expected_result` (frozen snapshot of the reference output, with the dataset version), `ordered` (boolean). Keep `expected_keywords` as an optional authoring aid. The schema is `.strict()`, so the change needs a migration path for existing rows. Note `difficulty-spec.test.ts` reads `tables` for L1-L3 structure.
- Data model: new `kql_datasets` table (tenant_id nullable = platform, RLS per `CLAUDE.md` rule 4, platform-authored per the platform-only content model). A `kql_runs` row per (attempt, question): status, duration, result hash, diff. Update `docs/02-data-model.md`.
- Grading: write a `gradings` row with `grader='deterministic'` like MCQ. Needs a sentinel version string, as in `mcq.ts:29`.
- UI: candidate sees tables and a "Run" preview (optional, later; run only against the sample dataset, with a rate limit). Admin attempt view shows the diff. Add `help_id` entries (`CLAUDE.md` rule 5).
- Docs: `docs/05-ai-pipeline.md` (not an AI path), `docs/06-deployment.md` (new container), `docs/03-api-contract.md`.

## 6. Recommendation and STOP

Recommend option (a), with `assessiq-kusto` on the internal network, caps set, one query at a time. Keep (d) as the fallback: manual scoring continues when the container is down or a question has no dataset.

**STOP.** This is not built in batch 8. It needs an owner decision on VPS capacity first. Measure what the neighbour apps use now (`docker stats`, `free -m`), then decide whether about 2 GB RAM for the emulator is available on the shared box. Without that decision, do not pull the image or edit compose. A change to `infra/**` is load-bearing and needs the additive-only check and a `codex:rescue` sign-off before push.
