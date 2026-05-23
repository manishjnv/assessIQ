# Design / Plan — Question-set sharing via clone-on-grant (Step 2)

> **Status:** BACKEND LIVE (2026-05-23). Phases 1–4 + same-PR docs + frontend API wiring shipped & deployed. **Only Phase 5 UI rendering remains.**
> **Predecessor:** Step 1 (platform-tenant master-library seed) shipped — migration `0083`, commit `b9d3c57`.
> **Routing:** load-bearing **and** security-adjacent (tenancy + entitlements + question-bank). UI work MUST read `docs/10-branding-guideline.md` first; consult the kit (`modules/17-ui-system/AssessIQ_UI_Template/`) — but the admin dashboard has its OWN established pattern (AdminShell + CSS vars + Card/Chip/Icon), so reuse existing admin pages (`platform.tsx`, `pack-detail.tsx`, `assessments.tsx`), don't lift from the candidate kit.

---

## ⏩ CONTINUATION (2026-05-23) — read this first

**Done & LIVE on `main` + production VPS (commits, in order):**
`c303fa0` Phase 1 schema (`0084` provenance cols + `tenant.pack_cloned` audit) · `79b1d6c` model-pivot doc · `13ba2f7` Phase 2 clone engine · `d7c3b95` Phase 3 lineage + catalog · `26583c7` Phase 4 clone-on-use · `6a9b2a6` review fixes (`0085` unique index + advisory lock) · `b5e5fb2` docs 02/03 · `e68f78e` frontend API wiring.

**Migrations applied to prod:** `0083`, `0084`, `0085` (recorded in `schema_migrations`). NOTE: prod has a long-standing `schema_migrations` *tracking gap* (most old migrations aren't recorded though their tables exist) — do NOT run the full `tools/migrate.ts` runner; apply any NEW migration manually via `psql` + record it (deploy doc § "Deploy procedure" step 2b). `assessiq-api`/`worker` already rebuilt with the backend.

**Live, working backend (all wired, verified 401-unauth):**
- `clonePackToTenant` / `materializeSetForTenant` — `modules/04-question-bank/src/clone.ts` (system-role clone; remap taxonomy by slug; idempotent via `source_pack_id`; advisory-lock serialized).
- `assertLicensedForSourcePack`, `listAvailableSetsForTenant`, `assertPublishEntitled` (clone-lineage aware) — `modules/19-billing/src/service.ts`.
- `createAssessmentFromSet` + `POST /api/admin/assessments/from-set` — `modules/05-assessment-lifecycle/src/{service,routes}.ts`.
- `GET /api/billing/available-sets` — `modules/19-billing/src/routes.ts`.
- **Frontend API helpers READY (not yet called by any UI):** `getAvailableSets()` and `createAssessmentFromSet(body)` + types `AvailableSet` / `CreateAssessmentFromSetRequest` — `modules/10-admin-dashboard/src/api.ts` (right after `getCompanyEntitlements`).

**Key model facts (so you don't re-derive):**
- A **domain license** (`scope_type='domain'`, `scope_id=<domain slug>`) covers ALL current + future platform sets in that domain. A **pack license** = one set (`scope_id=<platform pack id>`).
- The SA domain-grant UI **already exists** — `platform.tsx` billing drawer, `handleGrantEntitlement` (`~:813`), but `grantScopeType` is **hardcoded `'domain'`** (`:740`). So domain-licensing a company works TODAY end-to-end except the company has no picker to USE the set (that's 5b).
- Company assessments are **pack-based** here: the pool query filters by `pack_id` (`modules/05-assessment-lifecycle/src/service.ts:~184`); the blueprint path draws from a per-domain auto-pack, NOT arbitrary sets. So a granted set is consumed via the **from-set** path (clone → assessment from the clone), not the blueprint builder.

**Phase 5 — UI rendering (all that's left), in priority order:**
1. **5b (ESSENTIAL — unlocks the whole feature): company "Available sets" picker.** In `modules/10-admin-dashboard/src/pages/assessments.tsx` (large file; has a `BlueprintBuilder` ~`:194`+ and a create flow; it already calls `getCompanyEntitlements()` ~`:706` to filter domains). Add an "Assess from a set" mode: call `getAvailableSets()` → list licensed platform sets (name, domain, level_count, question_count, `update_available`) → user picks a set + a level (1-based `level_position`; the set has `level_count` levels) + name + opens_at (+ optional closes_at/question_count) → call `createAssessmentFromSet({source_pack_id, level_position, name, question_count, opens_at, ...})` → navigate to the created assessment. Handle `403 NOT_LICENSED`. This is company-admin facing.
2. **5a (refinement): pack-scope grants in the SA UI.** `platform.tsx` — add a scope-type toggle (domain | pack) to the grant form (`grantScopeType` is hardcoded at `:740`). For pack scope the `scope_id` is a PLATFORM published-pack id — you'll need a "list platform published packs" source for the dropdown (the existing `getTenantContentScopes` returns the *tenant's own* packs, not the platform's, so add a small SA endpoint or reuse the catalog). Domain grants already work, so this is optional polish.
3. **5c (cleanup): create-vs-catalog separation.** Move `✦ Generate` / `+ Add level` / `+ Add question` OFF `pack-detail.tsx` (header action bar `~:754-784`, plus the level/question section buttons) onto the Generate page (`modules/10-admin-dashboard/src/pages/generate-wizard.tsx`). The Question Bank should be view + status + (later) grant only.

**Verification owed (Phase 6):**
- `vite build` the admin-dashboard/frontend (the VPS build skips `tsc -b`, but a clean build is the gate; note pre-existing `AdminShell.tsx:183/186` `tsc` errors are NOT yours).
- Deploy: rebuild + recreate `assessiq-frontend` only (additive; do NOT touch `assessiq-marketing`).
- Behavioral end-to-end: SA grants a company the `soc` domain (platform billing drawer) → log in as that company admin → "Available sets" shows the platform SOC set → create an assessment from it → publish (passes `assertPublishEntitled` via domain match) → a candidate attempt draws the cloned questions.
- Concurrency test (owed, RCA 2026-05-23): parallel `from-set` for one `(tenant, source)` yields exactly one clone.

**Deferred follow-ups (NOT blocking; documented):** re-sync of an updated source (catalog already returns `update_available`); clone-archival on revoke (the publish gate already blocks revoked licenses for NEW assessments).

**Hazards:** (a) a PARALLEL SEO/marketing session shares this branch + VPS — coordinate, and only ever touch `assessiq-api`/`worker`/`frontend`, never `assessiq-marketing`. (b) Email-privacy push pattern (noreply env-var override) is in `~/.claude/CLAUDE.md`. (c) The per-phase prose BELOW still says "eager clone-at-grant" in places — the `## MODEL REVISION` block governs (standing license + clone-on-use).

---

## Context — why this work exists

Question generation is super-admin-only; the super admin curates a master library in the **platform** tenant (`slug='platform'`). The billing **entitlement** already records *which company may use what*, but it is only a **permission flag** — `assertPublishEntitled` checks a row exists and nothing copies the actual questions. A set the SA publishes in the platform library therefore **cannot reach any company's candidates**.

**Decision (this session):** close the gap with **clone-on-grant** — when the SA grants a company access to a published pack (or a domain), copy that pack + its questions from the platform tenant into the **company's own tenant**, tagged with provenance (`source_pack_id` + `source_version`).

**Why clone, not cross-tenant reference (rejected):** the codebase's core invariant is "every row belongs to exactly one tenant; RLS isolates" (lint-enforced). A reference model forces changes to RLS policies on 4 tables + the pool-selection query + blueprint FK validation — a large, security-sensitive blast radius. Clone keeps the invariant: the company only ever **reads its own rows at runtime**; the one cross-tenant action is a privileged **write-copy** under `assessiq_system`, gated by the grant. Downstream (assessment builder, pool selection, publish gate) needs **no changes**.

**Trade-off accepted:** clones do not auto-update. Solved with the provenance link + an opt-in "re-sync: source has a newer version" action (Phase 4). No forced live propagation.

---

## MODEL REVISION (2026-05-22) — standing license + clone-on-use

The grant is split into **license** (permission) and **delivery** (content), and delivery is **lazy**. This supersedes "eager clone at grant time" wherever the phases below say so. The Phase-1 schema and the Phase-2 `clonePackToTenant` engine are unchanged — only the **trigger** moves.

- **License = the entitlement row (permission only; no clone at grant).**
  - **Domain license** (`scope_type='domain'`, `scope_id=<domain slug>`) = a *standing* license to that whole domain: **all current AND future** published platform sets in it. Future sets are covered automatically — the publish-entitlement check matches by domain, not a frozen list.
  - **Pack license** (`scope_type='pack'`, `scope_id=<SOURCE platform pack id>`) = license to one specific set.
  - Reuses the existing `grantEntitlement` (no clone). Revoke reuses `revokeEntitlement`.
- **Catalog = "Available question sets"** — a read-only listing of published **platform** sets a tenant is licensed for (`pack.domain ∈ domain-licenses` OR `pack.id ∈ pack-licenses`). Metadata only (name, domain, level/question counts, version). New sets the super admin publishes **appear here automatically**. This is a narrow, license-gated cross-tenant **metadata READ** — NOT a runtime cross-tenant read of question content.
- **Delivery = clone-on-use.** When the company builds an assessment **from a licensed platform set**, that set is cloned into the company tenant **at that moment** (idempotent via `source_pack_id`), and the assessment is created from the clone. Candidates draw from the company's own stable copy.
- **Publish gate reconciliation:** `assertPublishEntitled` must accept a cloned pack via its lineage — extend the `pack`-scope match to `scope_id === pack.id OR scope_id === pack.source_pack_id` (domain-scope match is unchanged and already works because the clone preserves `domain`).

**Net effect on the phases:** Phase 1 ✓ unchanged. Phase 2 ✓ engine unchanged (called at use-time). Phase 3 → becomes the **catalog + publish-gate lineage extension** (not a grant+clone tx). Phase 4 → **clone-on-use at assessment creation** + re-sync/revoke. Phase 5 → SA "Grant license to company" button (pure entitlement, no clone) + company "Available sets" picker that triggers clone-on-use. The security-critical cross-tenant **write** now lives in the clone-on-use path (still gated by a server-side license re-check; still needs `codex:rescue`).

---

## Phase 0 — Documentation discovery (verified facts; "Allowed APIs")

All facts below are read verbatim from source this session (file:line). Build against these — do **not** invent signatures.

### Question bank — `modules/04-question-bank`
- `createPack(tenantId, input, createdByUserId)` — `src/service.ts:230`. Pack INSERT helper `insertPack` — `src/repository.ts:373` (cols: `id, tenant_id, slug, name, domain, description, created_by`; `status` defaults `draft`, `version` defaults `1`).
- `createQuestion(tenantId, input, createdByUserId)` — `src/service.ts:743`. Question INSERT helper `insertQuestion` — `src/repository.ts:710` (cols: `id, pack_id, level_id, type, topic, points, content, rubric, created_by`). **`insertQuestion` does NOT accept `domain_id`/`category_id`/`status`/`knowledge_base_sources`.**
- `insertAiDraftQuestion` — `src/repository.ts:738` — **does** accept `domain_id`/`category_id` (the AI-draft path). Reference for a new clone insert.
- `publishPack(tenantId, id, savedByUserId)` — `src/service.ts:404`. Version snapshot INSERT `insertQuestionVersion` — `src/repository.ts:933`.
- `findOrCreatePackForDomain(tenantId, domainId, createdByUserId)` — `src/service.ts:1274` (raw pack INSERT at `:1318`, level INSERT at `:1370`). Reserved slug format `dom-<domainSlug>`.
- `listAllQuestionsForPack` — `src/repository.ts:904` (ordered `created_at ASC`). `listLevelsByPack` — `src/repository.ts:469`. `insertLevel` — `src/repository.ts:496` (**does NOT take `rubric_defaults`** — added by 0017; clone must set it via a follow-up `updateLevelRow` or a new helper).
- Column constants — `src/repository.ts:54-62` (`PACK_COLUMNS`, `LEVEL_COLUMNS`, `QUESTION_COLUMNS`, `QUESTION_VERSION_COLUMNS`, `TAG_COLUMNS`).
- Tenancy: **every** write uses `withTenant(tenantId, fn)` (`SET LOCAL ROLE assessiq_app` + `set_config('app.current_tenant', …)`); no BYPASSRLS path in this module.
- Schema: `question_packs` direct-RLS, `UNIQUE(tenant_id, slug, version)`; `levels`/`questions`/`question_versions` JOIN-based RLS via `pack_id` (no `tenant_id` column); `questions` carries nullable `domain_id`/`category_id` (0018) + `knowledge_base_sources` (0016).
- **No clone/copy/source code exists anywhere** (exhaustive grep for `source_pack_id`/`cloned_from`/`origin_pack`/`copied_from`). Greenfield.

### Entitlements / billing — `modules/19-billing`
- `grantEntitlement(actorUserId, tenantId, {scopeType, scopeId})` — `src/service.ts:310`. **Two-phase tx pattern at `src/service.ts:336-369`** (copy this exactly): `BEGIN → SET LOCAL ROLE assessiq_system → mutate → SET LOCAL ROLE assessiq_app + set_config('app.current_tenant',…) → auditInTx → COMMIT`.
- `revokeEntitlement(...)` — `src/service.ts:381` (status UPDATE to `revoked`, never DELETE; `NotFoundError` if no active row).
- `assertPublishEntitled(client, tenantId, packId)` — `src/service.ts:507`. OR-rule at `:529-533`: entitled if `scope_type='pack' && scope_id===packId` **OR** `scope_type='domain' && scope_id===pack.domain` (slug). `internal` tier bypasses. **Consumes no credit.**
- `withSystemTx(fn)` — `src/service.ts:178` (single-role system tx, reads/single-phase writes only — NOT the two-phase pattern).
- `tenant_entitlements` — migration `0081`: `UNIQUE(tenant_id, scope_type, scope_id)`; INSERT/SELECT RLS under `assessiq_app`; **UPDATE/DELETE require `assessiq_system`**.
- **Credit consumption:** the ONLY writer of `billing_events` is `recordGradedAttempt` (`src/service.ts:58`), in the attempt→graded tx. **Cloning touches neither `billing_events` nor `attempts` → no credit consumed.**
- Audit: `auditInTx(client, input)` — `modules/14-audit-log/src/audit.ts:138`; `ACTION_CATALOG` — `modules/14-audit-log/src/types.ts:138-139` has `tenant.entitlement_granted` / `tenant.entitlement_revoked`. The validator throws on unknown actions, so a **new action must be added before first use**.

### API + assessment consumption + UI
- Entitlement routes (all `superAdminOnly`, all call `assertTenantActive` first) — `apps/api/src/routes/admin-super.ts`: GET `:880`, POST grant `:934`, DELETE revoke `:1519`; content-scopes GET `:904`. Company-admin GET `/api/billing/entitlements` — `modules/19-billing/src/routes.ts:58`.
- Admin client — `modules/10-admin-dashboard/src/api.ts`: `grantTenantEntitlement` `:702`, `revokeTenantEntitlement` `:719`, `getTenantEntitlements` `:688`, `getCompanyEntitlements` `:735`.
- Pool selection (criterion) — `modules/05-assessment-lifecycle/src/service.ts:184-199` — RLS-scoped, **no change needed for a cloned pack**.
- `createAssessment` — `:387`; blueprint mode skips the `published` check (`:462-476`), non-blueprint requires `pack.status='published'` (`:476`).
- `publishAssessment` → `assertPublishEntitled(client, tenantId, assessment.pack_id)` — `:693-696`.
- `assertBlueprintFKOwnership(client, tenantId, blueprint)` — `:244-290`: domain guard `WHERE id=$1 AND tenant_id=$2`; category guard `WHERE id=$1 AND domain_id=$2 AND tenant_id=$3`.
- Company-admin domain filter — `assessments.tsx:706-729` + `:216-221`: filters `DomainItem.slug` against active `scope_type='domain'` entitlement `scope_id`s.
- UI grant button attach points — `pack-detail.tsx:754-784` (header action bar, beside Publish) and `question-bank.tsx:384-412` (per-row action bar). Existing grant UI (`platform.tsx:813-829`) hardcodes `scopeType='domain'` (`:740`).

### THE decisive blocker (Agent-3 finding #1)
Cloned **questions** carry `domain_id`/`category_id` UUIDs pointing at the **platform** tenant's rows. `assertBlueprintFKOwnership` requires those to resolve in the **company's own** `domains`/`categories` (by `tenant_id`). **Every company tenant is already seeded with the same 9 domains/categories (same slugs)** — so the clone must **remap `domain_id`/`category_id` by SLUG** to the company tenant's matching rows. The pack's `domain` TEXT column must be preserved verbatim (so the domain-scope entitlement matches). This remap is the core of the clone engine — get it wrong and assessment creation throws `CROSS_TENANT_FK_REJECTED`.

---

## Phase 1 — Schema: provenance + audit action

**What to implement (copy the migration shape from `0083`/`0081`):**
- New migration `modules/04-question-bank/migrations/0084_pack_clone_provenance.sql`:
  - `ALTER TABLE question_packs ADD COLUMN source_pack_id UUID NULL, ADD COLUMN source_version INT NULL;` (nullable — only clones carry them; platform/originals stay NULL).
  - `ALTER TABLE questions ADD COLUMN source_question_id UUID NULL;` (lineage for grading/eval/analytics).
  - Index `question_packs (tenant_id, source_pack_id)` (used to find an existing clone for idempotency/re-sync).
  - No new RLS policies (columns ride existing table RLS). No FK to the source row (cross-tenant FK is impossible/undesirable — provenance is a soft reference).
- Add audit action `'tenant.pack_cloned'` to `ACTION_CATALOG` at `modules/14-audit-log/src/types.ts:139`.

**Verification:** `tools/migrate.ts --check` clean after apply; `psql` shows new columns nullable; existing rows unaffected (all NULL). `grep "'tenant.pack_cloned'" modules/14-audit-log/src/types.ts`.

**Anti-pattern guards:** do NOT make the provenance columns NOT NULL (breaks originals); do NOT add a cross-tenant FK; do NOT reuse `tenant.entitlement_granted` for the clone event (distinct concept, distinct audit row).

---

## Phase 2 — Clone engine (`modules/04-question-bank`)

**What to implement:** a new service `clonePackToTenant(sourcePackId, targetTenantId, actorUserId, client)` that runs **inside a caller-supplied `assessiq_system` transaction** (cross-tenant copy = privileged write; see Phase 3 for the tx owner). Frame each insert as "copy the insert at `repository.ts:NNN`, adding the new provenance columns."

Steps (all within the one system-role tx):
1. **Read source** (system role sees both tenants): source `question_packs` row, its `levels` (`listLevelsByPack`-shape SELECT), its `questions` (`listAllQuestionsForPack`-shape SELECT). Guard: source pack must belong to the platform tenant and be `status='published'`.
2. **Derive a collision-safe slug** in the target tenant: base `clone-<sourceSlug>`, retry `-2…-N` on `UNIQUE(tenant_id, slug, version)` (copy the retry loop from `createPack` `service.ts:285-320`). Preserve the `domain` TEXT verbatim.
3. **Insert pack** into target tenant (copy `insertPack` `repository.ts:373`) + set `source_pack_id`, `source_version = sourcePack.version`, `status='published'` (so non-blueprint assessments work immediately).
4. **Insert levels** (copy `insertLevel` `repository.ts:496`); then set `rubric_defaults` via `updateLevelRow` for any level that had it (insertLevel omits that column). Build a `sourceLevelId → newLevelId` map.
5. **Build slug→id maps** of the TARGET tenant's `domains` and `categories` (one query each, scoped to `targetTenantId`). For each source question, look up the source's domain/category SLUG (join source `domain_id`/`category_id` → platform domain/category → slug), then resolve to the target tenant's UUID via the maps. If a slug is missing in the target (custom platform domain not seeded for that company) → either skip with a recorded warning or seed it; **plan decision: skip + report** (don't silently attach a foreign UUID).
6. **Insert questions** via a NEW `insertClonedQuestion` repo helper (model on `insertAiDraftQuestion` `repository.ts:738`, which already takes `domain_id`/`category_id`) carrying: remapped `level_id`, remapped `domain_id`/`category_id`, original `type/topic/points/content/rubric/status/knowledge_base_sources`, `source_question_id = q.id`. Re-attach tags (copy the tag loop from `createQuestion` `service.ts` after `insertQuestion`).
7. Return `{ clonedPackId, questionCount, skippedCount }`.

**Verification:** unit test — clone a fixture platform pack into a test company tenant; assert pack/levels/questions counts match, `source_*` populated, `domain_id`/`category_id` resolve to the TARGET tenant's rows, `domain` TEXT preserved. RLS test: the company can SELECT the cloned pack; the platform tenant's originals are untouched.

**Anti-pattern guards:** do NOT copy `domain_id`/`category_id` UUIDs verbatim (the remap is mandatory — this is the blocker). Do NOT run the copy under `assessiq_app` (RLS would hide the source tenant's rows). Do NOT write `billing_events`. Do NOT hard-fail the whole clone on one missing category — skip + report.

---

## Phase 3 — Grant integration (entitlement + clone, one tx)

**What to implement:** a new super-admin operation `grantPackToCompany(actorUserId, targetTenantId, sourcePackId)` (and `grantDomainToCompany` for domain scope). Copy the **two-phase tx pattern from `grantEntitlement` `service.ts:336-369`**, inserting the clone in Phase A:

1. `BEGIN` → `SET LOCAL ROLE assessiq_system`.
2. `assertTenantActive(targetTenantId)` (copy `admin-super.ts:940`).
3. Idempotency: if a clone with `source_pack_id = sourcePackId` already exists in the target tenant, reuse it (don't double-clone); else `clonePackToTenant(...)` (Phase 2).
4. `insertEntitlement` — `scope_type='pack'`, `scope_id = clonedPackId` (precise) **or** `scope_type='domain'`, `scope_id = pack.domain` (bundle). Idempotent via `UNIQUE(tenant_id, scope_type, scope_id)`.
5. `SET LOCAL ROLE assessiq_app` + `set_config('app.current_tenant', targetTenantId, …)`.
6. `auditInTx` × 2: `'tenant.pack_cloned'` (after: source/clone ids, version, counts) + `'tenant.entitlement_granted'`.
7. `COMMIT`.
- Single-flight per `(sourcePackId, targetTenantId)` to avoid concurrent double-clone (copy the single-flight pattern used by `admin-generate.ts`).
- New API route `POST /api/admin/super/tenants/:tenantId/grant-pack` (`superAdminOnly`, body `{ sourcePackId, scope: 'pack'|'domain' }`) — copy the route wiring at `admin-super.ts:934-960`. Client fn `grantPackToCompany` in `api.ts` (copy `grantTenantEntitlement` `:702`).

**Verification:** integration test — grant a platform pack to a company → assert entitlement row + cloned pack both exist + two audit rows. Re-grant → no second clone (idempotent), entitlement unchanged. Assert no `billing_events` row written.

**Anti-pattern guards:** do NOT clone outside the entitlement tx (a clone with no grant, or a grant with no content, is a broken half-state). Do NOT pass `scope_id = sourcePackId` for a `pack` grant — it must be the CLONED pack id (the company never sees the platform pack id). Per the hard rule, this whole phase goes through `codex:rescue` before push (cross-tenant copy + authz).

---

## Phase 4 — Re-sync + revoke

**Re-sync (opt-in):** for a cloned pack whose `source_version < ` current source `version`, a super-admin "Re-sync" action re-runs the clone into the SAME target pack: archive-or-replace the old questions, insert the new snapshot, bump `source_version`. Surface "update available" by comparing `source_version` to the live source pack version. Never auto-propagate.

**Revoke:** extend `revokeEntitlement` flow (copy `service.ts:381`) so revoking a pack/domain grant ALSO sets the cloned pack(s) `status='archived'` in the target tenant (same system-role tx + audit). Archived packs can't seed new assessments; **in-flight attempts are unaffected** (attempts snapshot their questions). Never hard-delete (audit/history). 

**Verification:** revoke → cloned pack `archived`, entitlement `revoked`, existing attempts still resolve their questions. Re-sync → question set matches the newer source version; `source_version` bumped.

**Anti-pattern guards:** do NOT delete cloned content on revoke (breaks history + in-flight attempts). Do NOT auto-resync on every grant read (opt-in only).

---

## Phase 5 — Admin UI

**UI principle — create vs. catalog (clarified 2026-05-22):** the two surfaces have separate jobs.
- **Generate Questions page** (`generate-wizard.tsx`) = the place to **create**: ✦ Generate (AI), + Add level, + Add question, review/tune. All authoring affordances live here.
- **Question Bank page** (`question-bank.tsx` / `pack-detail.tsx`) = the **catalog**: browse/search, view a set, manage status (publish/archive), and **grant** a published set to a company. It manages and distributes; it does **not** create.
- **Cleanup required:** today `pack-detail.tsx` carries "✦ Generate / + Add level / + Add question" buttons (`pack-detail.tsx` header + level/question sections). Move these authoring actions onto the Generate page; leave the bank with view + status + grant only. Granting is distribution (a catalog action), so the "Grant to company…" button correctly stays on the bank.

**What to implement (copy the existing action-bar + drawer shapes):**
- "Grant to company…" button on `pack-detail.tsx:754-784` (beside Publish, `isSuperAdmin && status!=='archived'`) and optionally `question-bank.tsx:384-412` per-row. Opens a modal: pick company (reuse `listTenantsApi`), choose scope (this pack / its whole domain), confirm → `grantPackToCompany`.
- Keep `platform.tsx` billing drawer as the **audit + revoke** view; extend it to also list `scope_type='pack'` grants (today it hardcodes `'domain'` at `:740` — add a read-only render for pack-scope rows + their "Re-sync available" badge).
- Company-admin side needs **no change**: `assessments.tsx` already filters the blueprint domain picker by entitled domain slug (`:216-221`), and the seeded company domains match — so a granted+cloned domain appears automatically.

**Verification (behavioral, per "verify behavior not bundle"):** SA clicks Grant on a published platform pack → picks a company → company admin logs in → the domain appears in the blueprint builder → builds + publishes an assessment (passes `assertPublishEntitled`) → a candidate attempt draws the cloned questions.

**Anti-pattern guards:** don't expose the platform pack id to the company UI; don't let a company admin see the platform tenant's bank.

---

## Phase 6 — Verification (final)

1. `tools/migrate.ts --check` clean; `tools/lint-rls-policies.ts` passes (no new cross-tenant runtime read; provenance columns ride existing RLS).
2. Module test suites: `04-question-bank` (clone engine), `19-billing` (grant+clone tx, no credit), `05-assessment-lifecycle` (cloned pack publishes + pool draws).
3. End-to-end on a scratch tenant: grant → company assesses → revoke → archived. Confirm `billing_events` only written at grade time, never at clone/grant.
4. **`codex:rescue` adversarial sign-off** on the Phase 2+3 diff (threat model: a company must never read another tenant's rows at runtime; the only cross-tenant touch is the system-role write-copy; the clone must remap taxonomy, not leak platform UUIDs; grant must be atomic with clone).
5. Same-PR docs: `docs/02-data-model.md` (provenance columns + clone semantics), `docs/03-api-contract.md` (grant-pack route), `docs/04-auth-flows.md` if the authz note changes. RCA only if fixing a bug. SESSION_STATE handoff.

---

## Open questions — resolved decisions

1. **Domain-scope grant:** clone all **currently-published** packs in that domain at grant time; packs published **later** are NOT auto-cloned (avoids surprise bulk copies) — a later grant/re-sync picks them up.
2. **Billing:** clone consumes **no credit** (writes neither `billing_events` nor `attempts`); credits remain grade-time only.
3. **Question identity:** carry `source_question_id` (+ pack `source_pack_id`/`source_version`) for cross-tenant lineage in grading/eval/analytics.
4. **Revoke:** **archive** the cloned pack + set entitlement `revoked`; never hard-delete; in-flight attempts unaffected.
5. **Idempotency:** re-grant finds the existing clone via `source_pack_id` (no double-clone); entitlement `UNIQUE` makes the grant idempotent; re-sync bumps `source_version`.
6. **Where the clone runs:** one `assessiq_system` transaction owned by the grant handler (cross-tenant copy is a privileged write, NOT a runtime read), single-flight per `(source_pack, target_tenant)`, fully audited.

## Explicitly NOT in scope
- No cross-tenant runtime read path / RLS-policy changes (that was the rejected alternative).
- No change to the candidate take-flow, grading pipeline, or pool-selection query.
- No auto-propagation of source edits (re-sync is opt-in).
- No revert of the super-admin-only generation lock.
