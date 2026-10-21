# Future-ready question store — design v2 (EXP-14 and FUT-1 to FUT-9)

*Type: explanation + decision record.* Status: FINAL v2.1 (final Fable review applied), design only, no code. Date: 2026-10-21.
Roadmap rows: EXP-14, FUT-1 to FUT-9 (docs/ROADMAP.md, Z.4). Related rows: EXP-9, EXP-10, EXP-19, EXP-20, Q12, R2 (k6), Z-43.
How it was made: draft v1, then two independent validations against the code (Fable 5.1 and Opus 5.5). Both reports changed the draft. Section 8 lists what changed.

## 1. Goal and owner decisions

- One master question database. Only the platform super admin writes it (owner, 2026-10-21).
- Many licensed organisations (tenants) read it to run assessments.
- It must fit any future exam pattern and scale. Data of one organisation must never reach another.
- No database per exam, subject or class. Exam rules are data, not code.

## 2. What exists today (verified in code)

| Area | Fact | Where |
| --- | --- | --- |
| Master content | Platform tenant rows. Tenants cannot author packs | `04/src/clone/clone-on-grant.ts` guards |
| Use by a tenant | Clone on grant: copies pack, questions, versions, passages, source into the tenant, remapping taxonomy by slug | `clone-on-grant.ts:94-143`, migrations 0084, 0095 |
| Isolation | `tenant_id` + RLS. `questions` and `question_versions` check the tenant through `question_packs` (EXISTS, policy `FOR ALL`) | 0010, 0012:47, 0013:41 |
| Licence | `tenant_entitlements` (`scope_id` is TEXT: pack id or domain slug). Checked at publish and at create | `19-billing` 0081:60, `assertPublishEntitled`, `assertLicensedForSourcePack` |
| Freeze | `assessment_frozen_pool` at publish. `attempt_questions` pins `(question_id, version)` at start | 0096, 0031 |
| Types | TS registry plus generated SQL CHECK | `packages/question-types/src/registry.ts`, 0167 |
| Sections | Sequential locked sections, OR one whole-test timer. Mode is assessment-wide. A section draws by `category_ids` plus a count. Sections cannot combine with a blueprint | `05/src/types.ts:158-195`, `06/src/sections.ts` |

## 3. Decisions

### D1. One database, one master copy — ACCEPTED
Rejected: a database per exam, subject or class (RLS, billing, reports and audit need one place).

### D2. Licensed read first, one mode only — REVISED
- There is no real data and no customer clones yet (EXP-19). Build licensed read now. Do not ship clone mode first.
- No `QUESTION_STORE_MODE` flag. Two modes would double resync, takedown, stats and passage logic.
- Retiring `clone-on-grant` code is a dormant-feature deletion. It needs owner approval (Rule A). Until then the code stays and is not called for new grants.
- Rejected: fork-on-edit. Tenants cannot edit master content.

### D3. Licensed-read policy family — REVISED
- **Tables (11, plus `question_assets` from EXP-10 as the 12th):** `question_packs`, `levels`, `questions`, `question_versions`, `passages`, `question_tags`, `tags`, `question_taxonomy`, `question_source`, `domains`, `categories`. A policy subquery is itself filtered by RLS, so all of them need the rule, or the check returns zero rows.
- **Shape:** one `SECURITY DEFINER` function with a fixed `search_path` returns `uuid[]`, the platform packs this tenant may read. The policy is `tenant_id = current OR pack_id = ANY((SELECT readable_platform_packs()))`. The scalar subquery runs once per query, not once per row.
- **The function returns:** (a) packs that are `published` and covered by an active entitlement (pack scope, or domain scope matched on the lowercase slug, 0090), with draft questions and withdrawn items (`question_source`) excluded; plus (b) platform packs used by this tenant's own assessments (`assessments.pack_id`), with the draft exclusion kept (drafts never enter a frozen pool, 0096:17) and only the withdrawn filter lifted, so frozen and running tests keep working after a revoke.
- **Platform identity:** a `tenants.is_platform` flag, read inside the function. Not a session setting: the app role can set any `app.*` value (`with-tenant.ts:126`).
- **SELECT only.** The current `tenant_isolation` policy is `FOR ALL`. Split it: SELECT carries the OR; INSERT, UPDATE and DELETE stay tenant-only. Otherwise tenants gain UPDATE on platform rows.
- **Grandchild tables:** `question_versions`, `question_tags`, `question_taxonomy` and `question_source` have no `pack_id`, so `pack_id = ANY(...)` cannot apply. Add a `pack_id` to each (filled by the same `BEFORE INSERT` trigger) with an index, and write the policy as `tenant_id = current OR pack_id = ANY((SELECT readable_platform_packs()))` on every one. Do not fall back to a per-row EXISTS (verified 0013:26-37, 0169:155, 0194:37).
- **Function and indexes:** mark the function `STABLE`. Index `questions(tenant_id)`, `question_versions(tenant_id)` and the new `pack_id` columns.
- **Direct `tenant_id`** on `questions`, `question_versions` and `question_tags` (FUT-5 part 1; `passages` has it already, 0211:22). Fill it with a `BEFORE INSERT` trigger that copies it from the pack (and from the question for versions). No insert-site edits, so module 07 stays untouched.
- **Composite foreign keys** `(pack_id, tenant_id)` to `question_packs(id, tenant_id)` on questions, versions and passages. A foreign key ignores RLS, so without it a tenant could insert its own question into a platform pack.
- **Remove the app role's INSERT right on `tenant_entitlements`** (0081:84, grants 0002:53). Today a tenant session could grant itself a licence.
- **Migration safety:** (1) add the column nullable; (2) backfill from the pack; (3) set NOT NULL; (4) add the trigger; (5) drop and create the policies in ONE transaction. Never `DISABLE ROW LEVEL SECURITY`.
- **Known limit (threat model):** `assessiq_app` is a member of `assessiq_system` (0002:76), so an app session can `SET LOCAL ROLE assessiq_system` and bypass every policy (`with-tenant.ts:171`). This RLS design defends against logic bugs, not against SQL injection or a mis-routed system call. FUT-10 closes it.
- **Platform identity:** the code also uses `PLATFORM_TENANT_ID` and the slug `platform` (`02 purge.ts:8`). Add a startup assert that the `is_platform` row equals the config.
- **Lint:** extend `tools/lint-rls-policies.ts` so every licensed-read policy must be `FOR SELECT`.
- **Test harness:** `tools/test-support/apply-all-migrations.ts` applies all modules in number order. Four tests pick files by hand (04 `bulk-status-route`, `score-attempt-route`; 05 `blueprint-node-golden`; 19 `credit-ledger`). Check them.

### D4. A revoked licence must not break a running test — REPLACED
- v1 proposed a pinned-id read path. Rejected: `attempt_questions` has no `tenant_id` or `question_id` index, so it would scan.
- v2: part (b) of the D3 function. A tenant keeps read access to every platform pack that one of its own assessments uses. The `assessments.pack_id` lookup is cheap.
- Rejected alternative (Fable): keep the licence out of RLS and enforce it only in code (policy = published platform rows). Simpler, but a code bug then shows master keys to a paying tenant admin, and the database offers no defence.
- Audit target for the EXP-14 test plan (the line list goes stale, so keep it there only): readers that inner-join live `questions`, `passages`, `levels`, `question_packs`, `categories` and would lose rows: 06 `repository.ts:463,486,517,536,548,604-606,929,964,976,1112`, `result.ts:193,246`, `feedback.ts:221-222`; 09 `mcq.ts:77,156`, `repository.ts:149-152`; 07 `admin-grade.ts:318`, `admin-rerun.ts:124`, `admin-claim-release.ts:200`, `admin-manual-score.ts:120`, `super-evaluations.ts:130`, `repository.ts:855`; 15 `results-export.ts:115-127`, `repository.ts:236,397`; 20 `export.ts:89`. 18-certification reads none. Part (b) keeps them working. The reader audit stays in the EXP-14 test plan.
- `FOR SHARE` on a platform row is checked against UPDATE policies, so the 05 race guard (`_shared.ts:116,141`) would skip those rows. Replace it with a lock on the assessment row.
- Attempt start reads live `questions.points` and `negative_marks` (06 `repository.ts:433`). Under shared read a master edit would reach a running assessment. Read the frozen pool instead.

### D5. Answer keys hidden from licensed admins (FUT-2) — DECIDED by owner 2026-10-21
- **Rule:** a tenant admin never sees the answer key or rubric of licensed (platform-owned) content. This stops an answer leak by a licensee. Super admin sees everything. Tenant-owned content (EXP-17 uploads) stays fully visible to its own admins.
- **Where:** the sanitiser is applied on the admin read side for any question whose pack belongs to the platform tenant: `GET /api/admin/questions`, `/:id`, `/:id/versions` (04 `routes.ts:844-876`). Reuse the candidate allowlist idea (`sanitizeContentForCandidate`, 06 `repository.ts:574`): remove correct flags, `answer`, `explanation`, `rubric`, `answer_guidance` by registry hook (add an `adminView` hook next to `candidateView` in `registry.ts`).
- **Other admin surfaces to check (audit list, not maintained here):** attempt review and grading views (07 `admin-grade.ts`, `admin-rerun.ts`, `admin-manual-score.ts`), results export (15 `results-export.ts`), reports and feedback. They must show the candidate answer, the marks and the band, but not the master key. Server-side AI grading still reads the rubric; it never returns it.
- **Defence in depth:** keep the per-tenant rate bucket and the `buildQuestionWhere` licensed-packs filter (04 `repository.ts:745`). The hourly audit row stays dropped.
- **Break-glass key view (owner request 2026-10-21):** a licensed admin may open a proofreading window to see keys. One window = one step-up for ONE assessment that the admin created, not one per question. The window shows keys only for the questions in that assessment (its frozen pool).
  1. The admin starts a window for one of their own assessments, with a required reason. Step-up uses the existing fresh-MFA check (TOTP, as for super-admin writes), or an email OTP if the admin has no TOTP. No new OTP system.
  2. The window lasts 30 minutes (owner, 2026-10-21). The reveal cap is the question count of that assessment; reopening the same assessment the same day needs a new step-up, and a daily cap per admin and per tenant also applies. Keys show one question at a time, never in a list or an export. Copy, select, cut, drag, context menu, print and print-to-PDF are blocked in the view (no-select styles, event guards, print stylesheet that hides the key), and the admin name and time show as a watermark. This is a deterrent only: a screenshot or photo cannot be stopped, so the watermark and the audit row are the real controls.
  3. Alerts: one email to every other tenant admin and to the super admin when the window opens, and one summary email when it closes (count and question list). One email per reveal is rejected: it is spam for a proofreader. An immediate extra alert goes to the super admin when a cap is hit or when a window opens outside the tenant's working hours.
  4. Audit: one append-only `audit_log` row per reveal (actor, question id, version, reason, ip, window id) through `auditInTx` (module 14), plus rows for window open and close.
  5. Super admin can disable the feature for a tenant, and can revoke an open window.
- **Default path (no break-glass):** wrong-key reports go through the dispute flow (EXP-12); the super admin or a second platform reviewer fixes the master. Break-glass is the exception.
- **Effort:** M becomes L. It touches 01-auth (step-up), 13-notifications (two emails), 14-audit-log, 04 routes and a small admin screen.
- **Not included:** hiding keys from the candidate after release. Release levels already control this (06 `feedback.ts:298`).

### D6. Immutable versions and pins (FUT-1) — ACCEPTED, extended
- `BEFORE UPDATE` trigger on `question_versions`, column-specific like `passages_immutable` (0211:44-53), so a later `tenant_id` backfill passes. No code path updates it (zero hits outside migration 0156), but `attempt-engine.test.ts:1009` does and must change.
- Partial index `questions(source_question_id) WHERE source_question_id IS NOT NULL`.
- Composite foreign keys `attempt_questions(question_id, question_version)` and `assessment_frozen_pool(question_id, question_version)` to `question_versions(question_id, version)`. Today a pinned version can be deleted.

### D7. Question types stay a registry — ACCEPTED
- Add a type by a registry entry, a renderer and the generated CHECK. A type schema only adds optional fields. No `schema_version`, no `question_types` table (rejected twice, `docs/02-data-model.md` near lines 631 and 681).
- Binary assets (EXP-10 `question_assets`) join the policy family and are served through an attempt-scoped token, never by a stored path.
- FUT-6 adds an `interaction` flag when the first interactive type arrives.

### D8. Exam pattern as data — REVISED
- Today a section is: minutes, a category list and a count. It cannot carry a blueprint and cannot draw by difficulty or type mix.
- FUT-4: per-section `locked` flag. Needs the schema flag, an `entered_at` per block in `section_progress`, a guard in `assertSectionOpen` (06 `service.ts`) and the take page. Effort M-L.
- FUT-9 (new): draw rule per section (difficulty or type mix), and sections that can use a blueprint. A sixth unknown exam hits this first.
- FUT-7: per-question timer, only inside a locked block.
- Adaptive (Q12): a separate engine. Today the whole set is written at start (06 `repository.ts:420-438`). The frozen pool is one delivery mode, not the only one.

### D9. Translations (FUT-3) — ACCEPTED
Put the Hindi overlay inside versioned `content` (the version freezes it), not in `questions.content_i18n` (0194:82). Applies when EXP-9 starts.

### D10. Attempt data isolation — ACCEPTED
Attempt tables stay tenant-scoped and hold `question_id` plus `version`. FUT-5 part 2 (`tenant_id` on `attempt_questions` and `attempt_answers`) waits for the k6 run (R2).

### D12 (new). Privacy of data in a shared store (FUT-11, EXP-13 rule)
- Retention: no sweep exists for `attempts` and `attempt_answers` (only camera has one). FUT-11 adds `tenant_settings.attempt_retention_days` and a non-AI sweep that erases answers and events.
- Item statistics on shared items (EXP-13 calibration) use a system-role aggregate with a minimum-count floor (for example 5 attempts), so one tenant cannot infer another tenant's cohort. Per-tenant views stay per tenant.

### D11 (new). Taxonomy by node — blocker for D3 (FUT-8)
- Platform `questions.domain_id` and `category_id` point at the platform tenant's rows. Sections draw by tenant `category_ids` (05 `types.ts:162`); blueprints by `domain_id/category_id` (06 `repository.ts:978`); the frozen pool copies them (0096:57); exports inner-join `categories` (15 `results-export.ts:116,127`). None match a tenant's own ids. Clone hides this by slug remap.
- Fix: draw, freeze and report by `taxonomy_nodes` (shared NULL-tenant rows, 0169:118; the Z-43 path at 06 `repository.ts:966` already works). Drop category ids from sections and blueprints for platform content.
- Must be done before EXP-14 goes live, or draws silently return empty pools.

## 4. Build order (final)

1. **FUT-1** (S). Independent. First.
2. **FUT-8** (M). Taxonomy by node. Before the policy change.
3. **EXP-14** (XL, one migration set, one security batch gate). Includes FUT-5 part 1, D3, D4 and the reader audit. Sub-steps: columns and trigger and composite FKs; the `SECURITY DEFINER` function and policies; revoke the entitlements INSERT grant; reader fixes; lint extension.
4. **FUT-2** (S + list filter). With or right after EXP-14.
5. **FUT-10** (M, P2): close the `assessiq_system` membership. **FUT-11** (M, P2): attempt retention sweep. Both before real customer data.
6. Later, when a real need appears: **FUT-3** with EXP-9; **FUT-4** and **FUT-7** with an Azure-style exam; **FUT-9** with the next exam that needs a mix rule; **FUT-5 part 2** after the k6 numbers; **FUT-6** after EXP-10.

## 5. Tests that prove the risky parts

1. **Master keys do not leak.** Seed one platform tenant and three tenants (licensed, unlicensed, revoked). Seed a draft question in a published pack, a withdrawn item and a draft pack. Assert row counts on all 11 tables. Assert that `set_config` changes nothing. Assert that an app-role INSERT into `tenant_entitlements` fails. Assert that a tenant cannot UPDATE or INSERT into a platform pack.
2. **Readers keep their rows.** On a platform pack run publish, start, answer, grade, release, results export and certificate. Revoke the licence in the middle and run again. Counts must equal the clone-mode baseline.
3. **Policy cost.** Seed 10^6 questions and 10^6 attempt rows. `EXPLAIN ANALYZE` must show the function runs once (loops=1). A k6 start burst must stay under the target (R2).

## 6. Risks (ranked)

1. A policy gap leaks master answer keys (drafts, withdrawn items, a missing table, a self-granted licence). Mitigation: D3 and test 1.
2. Readers silently lose rows (inner joins, `FOR SHARE`, taxonomy). Mitigation: D4, D11 and test 2.
3. Policy cost at exam start. Mitigation: the once-per-query function and test 3.

## 7. Not included

- A database per exam, an adaptive engine, lab or simulation items, multi-exhibit tabs, per-option weights, retiring the clone code (needs owner approval).
- Compliance and legal text (owner handles offline).
- Any code. This page is design only.

## 8. What the validation changed from v1

- D2: flag dropped, licensed read first. D3: 3 tables became 11; `is_platform` flag instead of a session setting; SELECT-only split; composite foreign keys; entitlements INSERT grant removed. D4: pinned path replaced by part (b). D5: audit row dropped. D6: pin foreign keys added. D8: text corrected, FUT-9 added. D11 and FUT-8 added. EXP-14 raised from L to XL.
- Kept from v1: D1, D7, D9, D10. FUT-5 part 1 folded into EXP-14.
- The two validators disagreed on one point: licence in RLS (Opus) or in code (Fable). This design takes the RLS form for defence in depth and notes the trade-off in D4.

## 8b. Final Fable review (v2.1)
Verdict GOOD BUT GAPS, scores 3 to 4 of 5. Applied: grandchild `pack_id` and indexes, `STABLE`, threat-model limit, platform id assert, asset table, draft exclusion kept in D4(b), B2C key default, stats floor, FUT-10, FUT-11. Kept as right: SELECT-only split, composite FK, `is_platform` in a definer function, licence in RLS, immutable versions, registry types, taxonomy by node, no mode flag. Scale and performance scores (3) depend on the k6 run (R2).

## 9. Documents to update when built

`docs/02-data-model.md` (columns, policies, function), `docs/03-api-contract.md` (FUT-2 limits and list filter), `modules/04-question-bank/SKILL.md`, `modules/02-tenancy` SKILL (`is_platform`), `docs/06-deployment.md`, `docs/11-observability.md` if the rate bucket adds a metric.
