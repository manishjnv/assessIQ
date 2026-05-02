-- owned by modules/05-assessment-lifecycle
-- Phase 1 G1.B Session 3 — assessment lifecycle state enum.
--
-- Defines the canonical assessment_status type used by:
--   * assessments.status (this column drives the state machine)
--   * BullMQ boundary job (scans for `published` and `active` rows)
--
-- The state machine canonicalised in modules/05-assessment-lifecycle/SKILL.md:
--
--     create
--   draft ────────▶ published ────▶ active ────▶ closed
--      ▲              │  ▲             │
--      │              ▼  │             │
--      │        cancelled│             │
--      │                  └─reopen     │
--      └──unpublish (if no invitations)
--
--   draft     — editable, no candidates can see it
--   published — visible to admins; transitions to active when opens_at passes
--   active    — invited candidates can start (between opens_at and closes_at)
--   closed    — no new starts; in-progress attempts can submit; admin can reopen
--               if before closes_at
--   cancelled — terminal; for created-by-mistake assessments
--
-- WHY a Postgres ENUM type rather than TEXT + CHECK like other status columns:
--   The KICKOFF plan (`docs/plans/PHASE_1_KICKOFF.md` § Session 3 Migrations)
--   pinned ENUM for the assessment_status column specifically — it is the
--   primary state-machine surface and the explicit type catches typos at the
--   DB layer. Adding a new state requires `ALTER TYPE ... ADD VALUE`, which
--   is the desired friction (state-machine evolution is a rubric-level event,
--   not a casual edit). assessment_invitations.status stays TEXT + CHECK
--   because its enum is more likely to gain values (e.g. 'declined').

CREATE TYPE assessment_status AS ENUM (
  'draft',
  'published',
  'active',
  'closed',
  'cancelled'
);
