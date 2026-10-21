# Plans index

One row per plan. `docs/ROADMAP.md` lists the open work. A plan here is the spec behind one or more of its rows. Layout set 2026-10-15:

- `docs/ROADMAP.md`: the single open-work list (status board first, then the RW/FU/N rows). Former `docs/PENDING_TASKS_2026-10-01.md` and the former root `PENDING_TASKS` sheet.
- `docs/plans/`: open or still-referenced plans and specs.
- `docs/plans/archive/`: plans whose own status line says DONE, LIVE, SHIPPED or SUPERSEDED. Kept for history, never deleted (Rule A).
- `docs/design/`: design notes that are not plans.
- `.agent/plan.yaml`: the Autopilot task plan, generated from `docs/plans/PLAN_S10.md`. Change it with `ap change`, not by hand.

Rules: a new plan goes in `docs/plans/`. When its status line turns DONE or LIVE, `git mv` it to `archive/` and fix references with `git grep`. Put a `**Status:**` line in the first 25 lines of every plan. This index reads that line.

## Open or referenced

| Plan | Status line | Feeds |
| --- | --- | --- |
| [ADMIN_NAV_REVIEW_2026-10-17](ADMIN_NAV_REVIEW_2026-10-17.md) | REVIEW DONE 2026-10-17, no code yet | ROADMAP Z-21..Z-24 (admin help drawer, flow gaps, 15 → 7 nav regroup, flow-first Home) |
| [INVITATION_REMINDERS](INVITATION_REMINDERS.md) | no status line: verify before use | reminders feature (shipped in pilot batches 3-4) |
| [PLAN_S10](PLAN_S10.md) | no status line: verify before use | S10 Autopilot plan (`.agent/plan.yaml`) |
| [PRICING_TIERS_2026-10-06](PRICING_TIERS_2026-10-06.md) | no status line: verify before use | plan tiers (owner decisions) |
| [QUESTION_DIFFICULTY_PHASE_A](QUESTION_DIFFICULTY_PHASE_A.md) | DONE for Phase A (A1 `667286a`, A2 `fc61718`, A3 `2c102fa`), deployed (`7aed109`, `docs/SE | RW-50 (Phase B) |
| [react-router-7-upgrade-plan](react-router-7-upgrade-plan.md) | PLAN ONLY 2026-10-19, no upgrade without the owner yes | ROADMAP Z-38 |
| [Z-75-stop-tracking-public-docs](Z-75-stop-tracking-public-docs.md) | PLAN ONLY 2026-10-19, execution needs the owner yes | ROADMAP Z-75 |
| [REVIEW_FIX_PLAN_2026-10-02](REVIEW_FIX_PLAN_2026-10-02.md) | superseded 2026-10-16 (open items are in ROADMAP § P0-Z); was: PLAN (revision 2, 2026-10-02 late evening). RS1, RS2, RS3 and RS5 were worked on 2026-10-0 | P0-V rows in ROADMAP |
| [TENANT_USER_LIFECYCLE](TENANT_USER_LIFECYCLE.md) | DONE for Phases A-E. A `a1db97c` (plan + foundation), B `2af9849` (tenant Suspend/Resume/A | RW-48b tenant purge (Phase F) |
| [seo-audit-followups-plan](seo-audit-followups-plan.md) | superseded 2026-10-16 (open items are in ROADMAP § P0-Z); was: NOT STARTED. Saved 2026-05-27. | P3-F rows |

## Archive (closed)

| Plan | Status line | Feeds |
| --- | --- | --- |
| [ADMIN_MOBILE_PORT](archive/ADMIN_MOBILE_PORT.md) | no status line: verify before use |  |
| [ADMIN_MOBILE_PORT_IMPL](archive/ADMIN_MOBILE_PORT_IMPL.md) | DONE 2026-05-21 (c8349df). Phases A0 to A6 shipped; `ViewportLock` removed. |  |
| [BATCH_8_PROMPT](archive/BATCH_8_PROMPT.md) | no status line: verify before use |  |
| [CERTIFICATION_PLAN_GENERIC](archive/CERTIFICATION_PLAN_GENERIC.md) | no status line: verify before use |  |
| [EMAIL_KIT_PORT](archive/EMAIL_KIT_PORT.md) | DONE 2026-05-21 (df041d3). E0 to E2 shipped: all 9 templates use the kit contract. E3 vali |  |
| [MFA_ENROLLMENT_UX](archive/MFA_ENROLLMENT_UX.md) | DONE 2026-05-14 (94d5f34). Enrollment nudge and recovery-code fix shipped. The `MFA_REQUIR | RW-45 |
| [MOBILE_KIT_PORT](archive/MOBILE_KIT_PORT.md) | SHIPPED (M0–M6 complete, 2026-05-20).** Full candidate-facing surface mobile-tuned in a si |  |
| [PHASE_0_CLOSURE](archive/PHASE_0_CLOSURE.md) | DONE 2026-05-01 (6631d3f). Route layer and first VPS deploy closed. |  |
| [PHASE_0_KICKOFF](archive/PHASE_0_KICKOFF.md) | DONE 2026-05-01 (6631d3f). Phase 0 closure verification and handoff. |  |
| [PHASE_1_KICKOFF](archive/PHASE_1_KICKOFF.md) | DONE 2026-05-03 (2c9af6b). Phase 1 closure audit passed; re-drill 2026-05-14 (d92debc). |  |
| [PHASE_2_KICKOFF](archive/PHASE_2_KICKOFF.md) | DONE 2026-05-03 (18c06d9). Phase 2 modules 07 to 10 live; sharded generation followed in f |  |
| [PHASE_3_KICKOFF](archive/PHASE_3_KICKOFF.md) | DONE 2026-05-14 (dad0d9a). G3.A to G3.C shipped 2026-05-03 (ce041e3); G3.D audit sweep com |  |
| [PILOT_BATCHES_3_4](archive/PILOT_BATCHES_3_4.md) | LIVE on production (https://assessiq.in). |  |
| [PILOT_BATCH_5](archive/PILOT_BATCH_5.md) | LIVE on production (https://assessiq.in), deployed 2026-10-02 at `27f6357` (`21502db..27f6 |  |
| [PILOT_BATCH_6](archive/PILOT_BATCH_6.md) | LIVE on production (https://assessiq.in), deployed 2026-10-02 at `c214ef1` (`c1583a6..c214 |  |
| [PILOT_BATCH_7](archive/PILOT_BATCH_7.md) | LIVE on production (https://assessiq.in), deployed 2026-10-02 at `05beab3` (`c89b326..05be |  |
| [PILOT_BATCH_8](archive/PILOT_BATCH_8.md) | LIVE on production (https://assessiq.in), deployed 2026-10-02 at `6336f61` (`dcded5e..6336 |  |
| [PILOT_READINESS_BATCH](archive/PILOT_READINESS_BATCH.md) | LIVE on production (https://assessiq.in) since 1 October 2026, at commit `a86bce2`. Refere |  |
| [REVIEW_FIXES_RS1_RS5_N10_N12](archive/REVIEW_FIXES_RS1_RS5_N10_N12.md) | LIVE on production (https://assessiq.in). Code HEAD on `main`: `c788ed7`. Docs commits fol |  |
| [REVIEW_WAVE_2026-10-03](archive/REVIEW_WAVE_2026-10-03.md) | LIVE on https://assessiq.in. All code is committed and pushed. Open items are in section 1 |  |
| [REVIEW_WAVE_2_2026-10-03](archive/REVIEW_WAVE_2_2026-10-03.md) | on `main`. Wave A (`7e2af3d`) is live. Wave B (`ef01da2`, migration 0155) is deployed. Mar |  |
| [RS6_FEATURE_REVIEW_A](archive/RS6_FEATURE_REVIEW_A.md) | no status line: verify before use |  |
| [RS6_FEATURE_REVIEW_B](archive/RS6_FEATURE_REVIEW_B.md) | no status line: verify before use |  |
| [RS6_FEATURE_REVIEW_C](archive/RS6_FEATURE_REVIEW_C.md) | no status line: verify before use |  |
| [RS6_FEATURE_REVIEW_D](archive/RS6_FEATURE_REVIEW_D.md) | no status line: verify before use |  |
| [SCORING_RESULT_RELEASE](archive/SCORING_RESULT_RELEASE.md) | LIVE on production (https://assessiq.in) since 1 October 2026. |  |
| [SMALL_TASKS_N13_N18_RV16](archive/SMALL_TASKS_N13_N18_RV16.md) | LIVE or merged on `main`. Code HEAD: `38c76e3`. Range `62e01d8..38c76e3`, date 2026-10-03. |  |
| [UI_KIT_V1_1_PORT](archive/UI_KIT_V1_1_PORT.md) | no status line: verify before use |  |
| [assessiq-skill-plan](archive/assessiq-skill-plan.md) | ✅ complete (see §10). |  |
| [global-competitiveness-roadmap](archive/global-competitiveness-roadmap.md) | SUPERSEDED 2026-10-01 by docs/private/design/2026-10-01-product-review-competitive-strategy.md |  |
| [grading-completion-fix-plan](archive/grading-completion-fix-plan.md) | DONE. Fixed in commit `defb9f9` (2026-05-28), live on prod. | RCA, module 07 grading completion |
