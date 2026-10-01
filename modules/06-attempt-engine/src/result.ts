/**
 * Candidate-facing result contract (SP3, 2026-10-01) — owner rules P1/P2.
 *
 *   P1  A candidate sees ONLY a complete, final score: total, percent, pass/fail,
 *       certificate — and only after the result is RELEASED (attempts.status =
 *       'released'). Never a partial or provisional number, never per-question
 *       data, bands or justifications.
 *   P2  If the result will not be ready within about a minute, say so right away:
 *       "it will be emailed to <masked address> <turnaround>".
 *
 * Three read paths, all RLS-scoped (withTenant) and owner-checked (an attempt of
 * another candidate is a 404, same as the rest of the candidate surface):
 *   getSubmitExpectation  — what the submit screen should promise ('soon' | 'email')
 *   getCandidateResult    — GET /api/me/attempts/:id/result (200 released | 202 pending)
 *   listCandidateResults  — GET /api/me/results (released attempts only, newest first)
 *
 * 'soon' (the student waits on screen for ~a minute) iff the tenant releases
 * automatically (mode 'auto', switched on) AND every question of the attempt is an
 * MCQ (deterministic, finalised at submit) AND it is not an embed attempt (the host
 * app owns candidate communication). Everything else is 'email'.
 *
 * No AI, no model: pure SQL + arithmetic.
 */

import type { PoolClient } from "pg";
import { NotFoundError, config, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "./repository.js";
import { AE_ERROR_CODES } from "./types.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Types (wire shapes)
// ---------------------------------------------------------------------------

export type ResultExpectation = "soon" | "email";
export type ReleaseMode = "manual" | "auto";

export interface SubmitExpectation {
  /** 'soon' → show "Scoring your answers…" and poll /result ≤ 60 s; 'email' → show the email message. */
  result_expectation: ResultExpectation;
  /** The tenant's current release mode — lets the UI say "once {tenant_name} releases it" for manual tenants. */
  release_mode: ReleaseMode;
  /** r***@gmail.com style; '' only if the address could not be loaded. */
  email_masked: string;
  /** e.g. "within 72 hours" (EVALUATION_TURNAROUND_TEXT). */
  turnaround_text: string;
}

export interface CandidateCertificateRef {
  credential_id: string;
  verify_url: string;
}

export interface ReleasedResult {
  status: "released";
  total_earned: number;
  total_max: number;
  /** 0-100, one decimal. */
  percent: number;
  /** percent >= the level's passing_score_pct. */
  passed: boolean;
  assessment_name: string;
  released_at: string;
  certificate: CandidateCertificateRef | null;
}

export interface PendingResult extends SubmitExpectation {
  status: "pending";
  tenant_name: string;
}

export type CandidateResultView = ReleasedResult | PendingResult;

export interface ResultListItem {
  attempt_id: string;
  assessment_name: string;
  released_at: string;
  total_earned: number;
  total_max: number;
  percent: number;
  passed: boolean;
  certificate: CandidateCertificateRef | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "riya.sharma@gmail.com" → "r***@gmail.com". Never returns the full local part. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = [...local][0] ?? "";
  return `${first}***@${domain}`;
}

/** 0-100 with one decimal; 0 when there is no maximum. */
export function resultPercent(totalEarned: number, totalMax: number): number {
  return totalMax > 0 ? Math.round((totalEarned / totalMax) * 1000) / 10 : 0;
}

function verifyUrl(credentialId: string): string {
  return new URL(`/verify/${encodeURIComponent(credentialId)}`, config.ASSESSIQ_BASE_URL).toString();
}

function certificateRef(credentialId: string | null): CandidateCertificateRef | null {
  return credentialId === null
    ? null
    : { credential_id: credentialId, verify_url: verifyUrl(credentialId) };
}

// ---------------------------------------------------------------------------
// Expectation (shared by submit + the pending result body)
// ---------------------------------------------------------------------------

interface ExpectationRow {
  release_mode: ReleaseMode | null;
  auto_since_set: boolean | null;
  tenant_name: string;
  email: string;
  embed_origin: boolean;
  total_questions: number;
  non_mcq_questions: number;
}

async function loadExpectation(
  client: PoolClient,
  attemptId: string,
): Promise<(SubmitExpectation & { tenant_name: string }) | null> {
  const res = await client.query<ExpectationRow>(
    `SELECT ts.result_release_mode AS release_mode,
            (ts.result_release_auto_since IS NOT NULL) AS auto_since_set,
            t.name  AS tenant_name,
            u.email AS email,
            a.embed_origin,
            (SELECT COUNT(*)::int
               FROM attempt_questions aq WHERE aq.attempt_id = a.id) AS total_questions,
            (SELECT COUNT(*)::int
               FROM attempt_questions aq
               JOIN questions q ON q.id = aq.question_id
              WHERE aq.attempt_id = a.id AND q.type <> 'mcq') AS non_mcq_questions
       FROM attempts a
       JOIN users   u ON u.id = a.user_id
       JOIN tenants t ON t.id = a.tenant_id
       LEFT JOIN tenant_settings ts ON ts.tenant_id = a.tenant_id
      WHERE a.id = $1`,
    [attemptId],
  );
  const row = res.rows[0];
  if (row === undefined) return null;

  const mode: ReleaseMode = row.release_mode === "auto" ? "auto" : "manual";
  const soon =
    mode === "auto" &&
    row.auto_since_set === true &&
    row.total_questions > 0 &&
    row.non_mcq_questions === 0 &&
    !row.embed_origin;

  return {
    result_expectation: soon ? "soon" : "email",
    release_mode: mode,
    email_masked: maskEmail(row.email),
    turnaround_text: config.EVALUATION_TURNAROUND_TEXT,
    tenant_name: row.tenant_name,
  };
}

/**
 * What the submit screen should promise. Called AFTER submitAttempt committed:
 * a failure here must never turn a successful submit into an error, so it falls
 * back to the conservative "email" promise (and logs).
 */
export async function getSubmitExpectation(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<SubmitExpectation> {
  try {
    const exp = await withTenant(tenantId, async (client) => {
      const attempt = await repo.findAttemptById(client, attemptId);
      if (attempt === null || attempt.user_id !== userId) return null;
      return loadExpectation(client, attemptId);
    });
    if (exp !== null) {
      const { tenant_name: _tenantName, ...rest } = exp;
      return rest;
    }
  } catch (err) {
    log.warn({ err, tenantId, attemptId }, "submit.expectation_failed");
  }
  return {
    result_expectation: "email",
    release_mode: "manual",
    email_masked: "",
    turnaround_text: config.EVALUATION_TURNAROUND_TEXT,
  };
}

// ---------------------------------------------------------------------------
// GET /api/me/attempts/:id/result
// ---------------------------------------------------------------------------

interface ReleasedRow {
  assessment_name: string;
  total_earned: string;
  total_max: string;
  passing_score_pct: number;
  released_at: Date;
  credential_id: string | null;
}

/** released_at = the grading.released audit row; falls back to the score computation time. */
const RELEASED_AT_SQL = `COALESCE(
  (SELECT al.at FROM audit_log al
    WHERE al.entity_type = 'attempt' AND al.entity_id = a.id AND al.action = 'grading.released'
    ORDER BY al.at DESC LIMIT 1),
  s.computed_at)`;

export async function getCandidateResult(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<CandidateResultView> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null || attempt.user_id !== userId) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }

    if (attempt.status === "released") {
      const res = await client.query<ReleasedRow>(
        `SELECT asm.name AS assessment_name,
                s.total_earned::text AS total_earned,
                s.total_max::text    AS total_max,
                l.passing_score_pct,
                ${RELEASED_AT_SQL} AS released_at,
                c.credential_id
           FROM attempts a
           JOIN assessments asm ON asm.id = a.assessment_id
           JOIN levels l        ON l.id   = asm.level_id
           JOIN attempt_scores s ON s.attempt_id = a.id
           LEFT JOIN certificates c ON c.attempt_id = a.id AND c.revoked_at IS NULL
          WHERE a.id = $1`,
        [attemptId],
      );
      const r = res.rows[0];
      // A released attempt without a rollup row cannot show a complete score: stay
      // pending rather than ever showing a partial/provisional number (P1).
      if (r !== undefined) {
        const earned = parseFloat(r.total_earned);
        const max = parseFloat(r.total_max);
        const percent = resultPercent(earned, max);
        return {
          status: "released",
          total_earned: earned,
          total_max: max,
          percent,
          passed: percent >= r.passing_score_pct,
          assessment_name: r.assessment_name,
          released_at: new Date(r.released_at).toISOString(),
          certificate: certificateRef(r.credential_id),
        };
      }
      log.warn({ tenantId, attemptId }, "result.released_without_score_row");
    }

    const exp = await loadExpectation(client, attemptId);
    return {
      status: "pending",
      result_expectation: exp?.result_expectation ?? "email",
      release_mode: exp?.release_mode ?? "manual",
      email_masked: exp?.email_masked ?? "",
      turnaround_text: exp?.turnaround_text ?? config.EVALUATION_TURNAROUND_TEXT,
      tenant_name: exp?.tenant_name ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/me/results
// ---------------------------------------------------------------------------

export async function listCandidateResults(
  tenantId: string,
  userId: string,
): Promise<{ items: ResultListItem[] }> {
  return withTenant(tenantId, async (client) => {
    const res = await client.query<ReleasedRow & { attempt_id: string }>(
      `SELECT a.id AS attempt_id,
              asm.name AS assessment_name,
              s.total_earned::text AS total_earned,
              s.total_max::text    AS total_max,
              l.passing_score_pct,
              ${RELEASED_AT_SQL} AS released_at,
              c.credential_id
         FROM attempts a
         JOIN assessments asm ON asm.id = a.assessment_id
         JOIN levels l        ON l.id   = asm.level_id
         JOIN attempt_scores s ON s.attempt_id = a.id
         LEFT JOIN certificates c ON c.attempt_id = a.id AND c.revoked_at IS NULL
        WHERE a.user_id = $1
          AND a.status = 'released'
        ORDER BY released_at DESC, a.created_at DESC`,
      [userId],
    );
    return {
      items: res.rows.map((r) => {
        const earned = parseFloat(r.total_earned);
        const max = parseFloat(r.total_max);
        const percent = resultPercent(earned, max);
        return {
          attempt_id: r.attempt_id,
          assessment_name: r.assessment_name,
          released_at: new Date(r.released_at).toISOString(),
          total_earned: earned,
          total_max: max,
          percent,
          passed: percent >= r.passing_score_pct,
          certificate: certificateRef(r.credential_id),
        };
      }),
    };
  });
}
