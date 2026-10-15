import type { QuestionType } from "../types.js";

// ===========================================================================
// B3 — Re-sync an existing clone with a newer master version (in-place refresh)
// ===========================================================================
//
// MODEL (decided 2026-05-25): a re-sync refreshes the clone's CONTENT in place.
// Future attempts on any assessment using this clone pick up the refreshed
// content; IN-FLIGHT/COMPLETED attempts are never disturbed (their
// `attempt_questions` snapshot is frozen at a specific question_versions row).
// This is behaviourally identical to an admin editing the pack's questions —
// the platform never version-pins a published assessment at attempt-start; it
// always serves the latest committed snapshot (MAX(qv.version)) of active
// questions. So re-sync deliberately does NOT try to keep old published
// assessments on old content for new attempts (that would require an attempt-
// engine rewrite and isn't how the platform works anywhere).
//
// Matching is by `questions.source_question_id` (master question id, recorded at
// clone time). For each master ACTIVE question:
//   - new (no clone match) → INSERT (version=2 + qv{v1}), taxonomy-remapped.
//   - changed content/rubric → version-bump: INSERT qv at the clone question's
//     CURRENT version holding the NEW content, then bump questions.version. The
//     new content becomes MAX(qv.version) (future attempts); the prior snapshot
//     stays untouched (in-flight attempts keep it).
//   - unchanged → left alone (no version churn); reactivated if it had been archived.
// Clone questions whose master source is gone from the active set → archived.
// Finally bump question_packs.version and set source_version = master.version.

export interface CloneQuestionRow {
  id: string;
  source_question_id: string | null;
  content: unknown;
  rubric: unknown | null;
  version: number;
  status: string;
  // Live (non-versioned) metadata — read so re-sync can detect and apply
  // metadata-only master changes (level move, taxonomy change, points/topic/type)
  // that don't alter content/rubric. These fields live on the questions row, not
  // in question_versions, so updating them needs no version bump.
  level_id: string;
  points: number;
  topic: string;
  type: QuestionType;
  answer_guidance: string | null;
  domain_id: string | null;
  category_id: string | null;
}

export interface ResyncResult {
  clonePackId: string;
  /** false when the clone was already at/above the master version (no-op). */
  updated: boolean;
  /** clone.source_version before the re-sync. */
  fromVersion: number;
  /** master version the clone is now synced to. */
  toVersion: number;
  added: number;
  changed: number;
  archived: number;
  skipped: number;
  /** the clone pack's new version after the bump. */
  newPackVersion: number;
}

