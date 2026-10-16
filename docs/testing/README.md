# docs/testing/ — index of owner test scripts (FU-D25, 2026-10-06)

Local-only (`docs/` is gitignored; these `.docx` files are never committed).
Generators for them live in `docs/testing/generators/` — see that folder's
`README.txt` for regeneration steps. This index lists what each script proves
and whether it is current.

| Script | What it proves | Status |
|---|---|---|
| `AssessIQ_P0_Test_Script.docx` | Original P0 (go-live) walkthrough, v1. | **Stale.** Superseded by `_v2`. Kept for history only — do not run. |
| `AssessIQ_P0_Test_Script_v2.docx` | P0 go-live walkthrough plus R1 (aptitude regeneration), R2 (campus-lab rate limit), R4 (timer starts at Begin), A10 (MFA skip). | **Partly stale.** Per `generators/README.txt`: written before the results phase (SP1-SP4) and the evaluation queue (SP9-SP11) shipped — steps T6/T7 and the "Known limitations" table describe a world where candidates never saw a result; that is no longer true (students now see results / get the email). Refresh those steps from the scoring-release script before re-running in full. |
| `AssessIQ_Pilot_Batch2_Test_Script.docx` | Pilot batch 2 feature set (see `docs/plans/archive/PILOT_BATCHES_3_4.md`). | **Current for batch 2 only.** No dedicated script exists for batches 3-4 — `docs/plans/archive/PILOT_READINESS_BATCH.md` § "Verify on the live site" lists quick manual checks instead (numeric/multi-select question, two-section assessment with calculator, reminders, `/try`, integrity switches). |
| `AssessIQ_Scoring_Release_Test_Script.docx` | Scoring + result-release plan end to end: S1-S5 setup plus T1-T9 (85 steps, 32 starred as critical). Includes T10 (resend) and T11 (shuffle). Run **after** the P0 script. | **Current.** This is the owner's primary manual script as of 2026-10-03 (`docs/plans/archive/SCORING_RESULT_RELEASE.md`, `docs/plans/archive/PILOT_READINESS_BATCH.md`). |
| `AssessIQ_S11_Test_Script.docx` | Session S11 changes on the live site: question import by file upload and `Draft rubrics` (RW-97), generate-wizard draft warnings (RW-96), RW-87 pass 2 help copy and email wording, candidate erasure including the stored invitation email (RW-98), lost grading lock (RW-95, optional, operator only), page-split regression (RW-99). 74 steps, 29 starred. Release `1c1b6b6` (code deployed at `959a2b8`). | **Current.** Run after the Scoring script (it reuses that setup). |

## Not included in this index

- Automated specs (`apps/web/e2e/*.spec.ts`) — those are code, not owner scripts; see `docs/RCA_LOG.md` and `docs/ROADMAP.md` § E13 for their status.
- `docs/testing/AssessIQ_P0_Test_Script_v3.docx` — `generators/README.txt` names it as the next regeneration target but it does not exist yet (not built).

## Rule for the next session

Before writing a new test script or regenerating an old one, check this table
first (Rule B: compare old against new). Update this table in the same commit
as any script add/regenerate/retire.
