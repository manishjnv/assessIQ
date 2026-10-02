// AssessIQ — shared grading panel.
//
// The per-attempt grading UI, extracted from attempt-detail.tsx (spec
// 2026-10-01 §5) so the two pages that show it share ONE implementation:
//
//   mode="evaluate"  super-admin evaluate page
//                    apiBase = /admin/super/evaluations/<attemptId>
//                    Grade all, per-question proposals, Accept / Accept all,
//                    Re-run, manual score, Override.
//   mode="review"    tenant attempt detail
//                    apiBase = /admin
//                    Final grades + Override only. AI actions are super-admin
//                    only, so none of the evaluate controls render.
//
// Four zones per question — Question / Expected answer / Candidate answer /
// Evaluation — keep what was asked, expected, written and scored strictly apart.
//
// Release hand-over (owner decision 2026-10-01): in evaluate mode the accept /
// manual score / override that completes the attempt releases it to the company on
// the server, in the same step — there is no separate click. The panel warns before
// the action that would do it (inline notice, no extra confirm) and the page shows the
// "Released to <company>" state afterwards. A sent-back attempt (already graded) is
// not auto-released; it gets "Re-run AI" here and the page's "Release to company".
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - ai_justification + candidate answer displayed as plain text only.
//  - Grades shown are the EFFECTIVE grading per question (newest row; an
//    override wins), so an override is visible after it is saved.
//  - Fresh-MFA failures open the shared MfaStepUp and retry (useMfaGuard).

import React, { useEffect, useMemo, useState } from "react";
import { Spinner } from "@assessiq/ui-system";
import { GradingProposalCard } from "./GradingProposalCard.js";
import { EscalationDiff } from "./EscalationDiff.js";
import { ScoreDetail } from "./ScoreDetail.js";
import { BandPicker } from "./BandPicker.js";
import { QuestionPromptView } from "./QuestionPromptView.js";
import { ExpectedAnswerView } from "./ExpectedAnswerView.js";
import { ConceptCoverageView } from "./ConceptCoverageView.js";
import { useMfaGuard } from "./useMfaGuard.js";
import { adminApi, AdminApiError } from "../api.js";
import { bandToScore } from "../lib/band-score.js";
import {
  apiMessage,
  completesWith,
  effectiveGradings,
  evaluationMeta,
  isAiFailure,
  isErrorCode,
  isNewerThanGrade,
} from "../lib/evaluation.js";
import type { AttemptDetailResponse, FrozenQuestion } from "../lib/evaluation.js";
import type { GradingProposal, GradingsRow } from "@assessiq/ai-grading";

export interface AttemptGradingPanelProps {
  detail: AttemptDetailResponse;
  /** Re-fetch the attempt after a mutation (must be a stable function). */
  reload: () => Promise<void>;
  mode: "evaluate" | "review";
  /**
   * Per-attempt API prefix. evaluate: `/admin/super/evaluations/<attemptId>`
   * (grade, accept, rerun, questions/:id/manual-score, gradings/:id/override).
   * review: `/admin` (gradings/:id/override only).
   */
  apiBase: string;
  /** Show the Override control on graded questions. */
  canOverride: boolean;
  /** Surface a message in the page's error banner (null clears it). */
  onError: (message: string | null) => void;
}

interface OverrideFormState {
  questionId: string | null;
  gradingId: string | null;
  band: number | null;
  /** score_max of the grading being overridden — the band is scaled to it. */
  scoreMax: number | null;
  justification: string;
  reason: string;
}

const EMPTY_OVERRIDE: OverrideFormState = {
  questionId: null,
  gradingId: null,
  band: null,
  scoreMax: null,
  justification: "",
  reason: "",
};

/** Attempt statuses the server will grade (admin-grade.ts). */
const GRADEABLE_STATUSES = ["submitted", "auto_submitted", "pending_admin_grading"];
const AI_GRADEABLE_TYPES = new Set(["subjective", "scenario", "log_analysis"]);
/** A grading marker older than this is treated as stalled (API restarted mid-batch). */
const STALE_MARKER_SEC = 600;
/** Stop polling a marker older than this. */
const POLL_CAP_SEC = 720;

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

const PILL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "2px 8px",
  borderRadius: "var(--aiq-radius-pill, 999px)",
};

const BANNER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--aiq-space-md)",
  padding: "var(--aiq-space-md) var(--aiq-space-xl)",
  borderRadius: "var(--aiq-radius-sm, 4px)",
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
};

const ANSWER_TEXT_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-md)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  color: "var(--aiq-color-fg-secondary)",
  borderLeft: "2px solid var(--aiq-color-border)",
  paddingLeft: "var(--aiq-space-md)",
};

const ANSWER_SUBLABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
  marginBottom: "var(--aiq-space-2xs)",
};

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

function asAnswerObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function NoAnswer({ label }: { label: string }): React.ReactElement {
  return (
    <p style={{ ...ANSWER_TEXT_STYLE, fontStyle: "italic", color: "var(--aiq-color-fg-muted)" }}>
      {label}
    </p>
  );
}

/**
 * Plain-text serialisation of a candidate answer, used ONLY for
 * ConceptCoverageView's match-highlighting. Returns "" for question types
 * whose answers are non-narrative (mcq/kql) so coverage view is suppressed
 * for those types. Phase 3 review UX (2026-05-29).
 */
function serializeAnswerForCoverage(type: string, answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (answer === null || answer === undefined) return "";
  if (typeof answer !== "object") return "";
  const a = answer as Record<string, unknown>;
  switch (type) {
    case "subjective":
      return typeof a.response === "string" ? a.response : "";
    case "log_analysis": {
      const findings = Array.isArray(a.findings)
        ? a.findings.filter((f) => typeof f === "string").join("\n")
        : "";
      const explanation = typeof a.explanation === "string" ? a.explanation : "";
      return [findings, explanation].filter(Boolean).join("\n\n");
    }
    case "scenario": {
      if (!Array.isArray(a.steps)) return "";
      return a.steps
        .map((s, i) => {
          const obj = s as Record<string, unknown> | null;
          const resp = obj && typeof obj.response === "string" ? obj.response : "";
          return resp ? `Step ${i + 1}: ${resp}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    default:
      // mcq, kql, unknown types — return "" so the coverage view is omitted
      return "";
  }
}

function AttemptAnswerView({ type, content, answer }: { type: string; content: unknown; answer: unknown }): React.ReactElement {
  // Legacy / plain-string answers render directly.
  if (typeof answer === "string") {
    return answer.trim() === "" ? <NoAnswer label="No answer submitted." /> : <p style={ANSWER_TEXT_STYLE}>{answer}</p>;
  }

  const a = asAnswerObj(answer);
  const isEmpty = answer === null || answer === undefined || (a !== null && Object.keys(a).length === 0);
  if (isEmpty && !(type === "mcq" && typeof answer === "number")) {
    return <NoAnswer label="No answer submitted." />;
  }

  switch (type) {
    case "mcq": {
      // canonical: { selected: number }; tolerate a bare numeric index too.
      const selected =
        typeof a?.selected === "number" ? a.selected :
        typeof answer === "number" ? answer : null;
      if (selected === null) break;
      const c = asAnswerObj(content);
      const options = Array.isArray(c?.options) ? (c!.options as unknown[]) : [];
      const correct = typeof c?.correct === "number" ? c!.correct : null;
      const optText = typeof options[selected] === "string" ? (options[selected] as string) : "";
      const isCorrect = correct === null ? null : selected === correct;
      const mark = isCorrect === true ? " ✓" : isCorrect === false ? " ✗" : "";
      const markColor = isCorrect === true ? "var(--aiq-color-success, #065f46)" : isCorrect === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)";
      return (
        <p style={ANSWER_TEXT_STYLE}>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: markColor }}>
            {OPTION_LETTERS[selected] ?? selected}{mark}
          </span>
          {optText}
        </p>
      );
    }

    case "numeric": {
      const v = typeof answer === "number" ? answer : typeof a?.value === "number" ? a.value : null;
      if (v === null) break;
      const c = asAnswerObj(content);
      const want = typeof c?.answer === "number" ? c.answer : null;
      const tol = typeof c?.tolerance === "number" && c.tolerance >= 0 ? c.tolerance : 0;
      const ok = want === null ? null : Math.abs(v - want) <= tol + 1e-9;
      const unit = typeof c?.unit === "string" ? ` ${c.unit}` : "";
      return (
        <p style={ANSWER_TEXT_STYLE}>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: ok === true ? "var(--aiq-color-success, #065f46)" : ok === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)" }}>
            {v}{unit}{ok === true ? " ✓" : ok === false ? " ✗" : ""}
          </span>
        </p>
      );
    }

    case "multi_select": {
      const sel = Array.isArray(a?.selected) ? (a!.selected as unknown[]).filter((x): x is number => typeof x === "number") : Array.isArray(answer) ? (answer as unknown[]).filter((x): x is number => typeof x === "number") : null;
      if (sel === null) break;
      if (sel.length === 0) return <NoAnswer label="No options selected." />;
      const c = asAnswerObj(content);
      const options = Array.isArray(c?.options) ? (c!.options as unknown[]) : [];
      const key = Array.isArray(c?.correct) ? (c!.correct as unknown[]) : null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          {sel.map((i) => {
            const ok = key === null ? null : key.includes(i);
            return (
              <p key={i} style={ANSWER_TEXT_STYLE}>
                <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: ok === true ? "var(--aiq-color-success, #065f46)" : ok === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)" }}>
                  {OPTION_LETTERS[i] ?? i}{ok === true ? " ✓" : ok === false ? " ✗" : ""}
                </span>
                {typeof options[i] === "string" ? (options[i] as string) : ""}
              </p>
            );
          })}
        </div>
      );
    }

    case "subjective": {
      const text = typeof a?.response === "string" ? a.response : null;
      if (text === null) break;
      return text.trim() === "" ? <NoAnswer label="No answer submitted." /> : <p style={ANSWER_TEXT_STYLE}>{text}</p>;
    }

    case "kql": {
      const query = typeof a?.query === "string" ? a.query : null;
      if (query === null) break;
      if (query.trim() === "") return <NoAnswer label="No query submitted." />;
      return (
        <pre
          style={{
            margin: 0,
            padding: "var(--aiq-space-sm)",
            background: "var(--aiq-color-bg-secondary, #f8f8f8)",
            borderRadius: 4,
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--aiq-color-fg-primary)",
            border: "1px solid var(--aiq-color-border, #e5e7eb)",
          }}
        >
          {query}
        </pre>
      );
    }

    case "log_analysis": {
      const findings = Array.isArray(a?.findings)
        ? (a!.findings as unknown[]).filter((f): f is string => typeof f === "string" && f.trim() !== "")
        : [];
      const explanation = typeof a?.explanation === "string" ? a.explanation : "";
      if (findings.length === 0 && explanation.trim() === "") break;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
          {findings.length > 0 && (
            <div>
              <div style={ANSWER_SUBLABEL_STYLE}>Findings</div>
              <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
                {findings.map((f, i) => (
                  <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)" }}>
                    {f}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {explanation.trim() !== "" && (
            <div>
              <div style={ANSWER_SUBLABEL_STYLE}>Explanation</div>
              <p style={ANSWER_TEXT_STYLE}>{explanation}</p>
            </div>
          )}
        </div>
      );
    }

    case "scenario": {
      const steps = Array.isArray(a?.steps) ? (a!.steps as unknown[]) : [];
      const rows = steps
        .map((s, i) => {
          const so = asAnswerObj(s);
          const resp = typeof so?.response === "string" ? so.response : "";
          const idx = typeof so?.stepIndex === "number" ? so.stepIndex : i;
          return { idx, resp };
        })
        .filter((r) => r.resp.trim() !== "");
      if (rows.length === 0) break;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
          {rows.map((r, i) => (
            <div key={i}>
              <div style={ANSWER_SUBLABEL_STYLE}>Step {r.idx + 1}</div>
              <p style={ANSWER_TEXT_STYLE}>{r.resp}</p>
            </div>
          ))}
        </div>
      );
    }
  }

  // Unrecognised / malformed shape — readable message, never raw JSON.
  return <NoAnswer label="Answer recorded — no readable preview available." />;
}

// ---------------------------------------------------------------------------
// AuditZone — one labelled, colour-accented block of the per-question audit
// card. The four zones (Question / Expected answer / Candidate answer / AI
// evaluation) give the admin a clear, consistent demarcation between what was
// asked, what was expected, what the candidate wrote, and how the AI scored it.
// ---------------------------------------------------------------------------

const ZONE_LABEL_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--aiq-space-xs)",
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: "var(--aiq-space-sm)",
};

function AuditZone({
  label,
  icon,
  accent,
  children,
}: {
  label: string;
  icon: string;
  accent: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderLeft: `3px solid ${accent}`,
        borderRadius: "var(--aiq-radius-md, 6px)",
        padding: "var(--aiq-space-md)",
        background: "var(--aiq-color-bg-base, #fff)",
      }}
    >
      <div style={{ ...ZONE_LABEL_STYLE, color: accent }}>
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ReleaseNotice — shown BEFORE the action that would complete the evaluation. The
// server releases the result to the company in that same step, so the evaluator
// is told up front instead of being asked to confirm a second time.
// ---------------------------------------------------------------------------

function ReleaseNotice({ tenantName, action }: { tenantName: string; action: string }): React.ReactElement {
  return (
    <p
      role="note"
      className="aiq-no-print"
      data-test-id="release-notice"
      style={{
        margin: 0,
        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
        borderLeft: "3px solid var(--aiq-color-info, #3177dc)",
        backgroundColor: "var(--aiq-color-info-subtle, #eef4ff)",
        borderRadius: "var(--aiq-radius-sm, 4px)",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        lineHeight: 1.5,
        color: "var(--aiq-color-fg-secondary)",
      }}
    >
      {action} releases this result to {tenantName}. If {tenantName} publishes automatically, the student gets it within a minute.
    </p>
  );
}

// ---------------------------------------------------------------------------
// ManualScoreForm — a score entered by hand for a question with no grade
// (KQL, or an AI answer the evaluator would rather score directly).
// ---------------------------------------------------------------------------

function ManualScoreForm({
  max,
  busy,
  onSubmit,
  onCancel,
  releaseNotice,
}: {
  max: number;
  busy: boolean;
  onSubmit: (score: number, reason: string) => void;
  onCancel?: () => void;
  /** Rendered above the buttons when saving this score would release the result. */
  releaseNotice?: React.ReactNode;
}): React.ReactElement {
  const [score, setScore] = useState("");
  const [reason, setReason] = useState("");
  const n = Number(score);
  const valid =
    score.trim() !== "" &&
    Number.isFinite(n) &&
    n >= 0 &&
    n <= max &&
    reason.trim().length > 0 &&
    reason.trim().length <= 500;

  return (
    <div
      className="aiq-card aiq-no-print"
      data-help-id="admin.evaluations.manual_score"
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)" }}
    >
      <span style={MONO_LABEL}>Manual score</span>
      <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
        <span style={MONO_LABEL}>Score (0 to {max})</span>
        <input
          type="number"
          className="aiq-input"
          min={0}
          max={max}
          step="any"
          value={score}
          onChange={(e) => setScore(e.target.value)}
          style={{ maxWidth: 160 }}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
        <span style={MONO_LABEL}>Reason (required)</span>
        <textarea
          className="aiq-admin-longform-textarea"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", resize: "vertical" }}
        />
      </label>
      {releaseNotice}
      <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
        <button
          type="button"
          className="aiq-btn aiq-btn-primary aiq-btn-sm"
          disabled={busy || !valid}
          onClick={() => onSubmit(n, reason.trim())}
        >
          Save score
        </button>
        {onCancel && (
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AttemptGradingPanel({
  detail,
  reload,
  mode,
  apiBase,
  canOverride,
  onError,
}: AttemptGradingPanelProps): React.ReactElement {
  const evaluate = mode === "evaluate";
  const { attempt, answers, frozen_questions, gradings } = detail;
  const effective = useMemo(() => effectiveGradings(gradings), [gradings]);

  // Per-question proposal state (keyed by question_id).
  const [proposals, setProposals] = useState<Record<string, GradingProposal>>({});
  // Re-run (Stage 3) proposals, kept beside the Stage 2 ones for the diff.
  const [escalationProposals, setEscalationProposals] = useState<Record<string, GradingProposal>>({});
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});
  const [overrideForm, setOverrideForm] = useState<OverrideFormState>(EMPTY_OVERRIDE);
  const [grading, setGrading] = useState(false);
  const [acting, setActing] = useState(false);
  const { guard, stepUp } = useMfaGuard(
    "This action needs a fresh authenticator check. Enter your 6-digit code to continue.",
  );

  // Hydrate from the server-side cache: a Grade-all whose response was lost to a
  // proxy timeout (or a tab navigation) is recoverable on the next load. Proposals
  // for questions that are already graded are filtered out at render time, so
  // nothing needs removing from this state after an accept.
  const cachedProposals = detail.ai_proposals;
  useEffect(() => {
    if (!evaluate) return;
    const map: Record<string, GradingProposal> = {};
    if (Array.isArray(cachedProposals)) for (const p of cachedProposals) map[p.question_id] = p;
    setProposals(map);
  }, [evaluate, cachedProposals]);

  // While the server reports a batch in flight, re-fetch every 15 s so proposals
  // land without a manual refresh. Capped so a permanently stuck marker (API
  // SIGKILL mid-batch) does not poll forever.
  const startedAt = detail.grading_started_at;
  useEffect(() => {
    if (!evaluate || startedAt == null) return;
    const elapsedSec = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
    if (elapsedSec > POLL_CAP_SEC) return;
    const interval = setInterval(() => {
      void reload();
    }, 15_000);
    return () => clearInterval(interval);
  }, [evaluate, startedAt, reload]);

  const isGradeable = evaluate && GRADEABLE_STATUSES.includes(attempt.status);
  const gradingElapsedSec =
    startedAt != null ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
  const gradingStalled = startedAt != null && gradingElapsedSec > STALE_MARKER_SEC;
  const gradingActive = startedAt != null && !gradingStalled;

  // Evaluation hand-over state (evaluate mode). The company's name is only used for wording.
  const meta = evaluationMeta(detail);
  const tenantName = meta.tenant_name ?? "the company";
  // Sent back by the company, re-evaluated by AssessIQ: graded, not with the company, send-back
  // marker set. Only here does the panel offer the attempt-level "Re-run AI" (Grade all is
  // refused by the server for a graded attempt) and show re-run proposals over existing grades.
  const canRerunAi =
    evaluate && attempt.status === "graded" && !meta.evaluation_released_at && !!meta.evaluation_sent_back_at;
  // Finalising only happens on a pre-graded attempt; a graded one is never auto-released.
  const completesOnAction = (questionIds: readonly string[]): boolean =>
    isGradeable &&
    completesWith(
      questionIds,
      frozen_questions.map((q) => q.id),
      effective,
    );

  // The proposals that still call for a decision. A question with no grade yet: its proposal.
  // A question that already has a grade: only a RE-RUN proposal (canRerunAi) and only while it
  // is newer than that grade — accepting it, or an override, makes the grade newer and the
  // card goes away. Everything else stays hidden, as before.
  const shown = useMemo(() => {
    const m = new Map<string, GradingProposal>();
    for (const p of Object.values(proposals)) {
      const g = effective.get(p.question_id);
      if (g === undefined || (canRerunAi && isNewerThanGrade(p, g))) m.set(p.question_id, p);
    }
    return m;
  }, [proposals, effective, canRerunAi]);
  const pending = useMemo(() => [...shown.values()], [shown]);
  const acceptable = pending.filter((p) => !isAiFailure(p));

  // ── Actions ──────────────────────────────────────────────────────────────

  // Grade all (pre-graded attempt) and Re-run AI (sent-back attempt) are the same shape:
  // one synchronous whole-attempt AI batch on the admin's click, proposals back, nothing
  // committed until Accept. The server marks the run in progress and caches the result, so
  // a proxy timeout is recoverable by polling.
  async function runBatch(endpoint: "grade" | "rerun"): Promise<void> {
    setGrading(true);
    try {
      const res = await adminApi<{ proposals: GradingProposal[] }>(`${apiBase}/${endpoint}`, {
        method: "POST",
        // The rerun route validates { forceEscalate? }; the attempt-level run sends none.
        ...(endpoint === "rerun" ? { body: JSON.stringify({}) } : {}),
      });
      const map: Record<string, GradingProposal> = {};
      for (const p of res.proposals) map[p.question_id] = p;
      onError(null);
      setProposals(map);
      // Reload to pick up the cleared grading_started_at in the same tick.
      void reload();
    } catch (err) {
      // A CF/proxy timeout (504/524/408) on a slow batch is non-fatal: the
      // server persists the batch, so reload (starts the poll) instead of failing.
      const isTimeout =
        err instanceof AdminApiError && (err.status === 504 || err.status === 524 || err.status === 408);
      onError(
        isTimeout
          ? `${endpoint === "grade" ? "Grading" : "Re-running"} is taking longer than the connection timeout — it continues on the server. This page will refresh automatically when ${endpoint === "grade" ? "proposals" : "the new grades"} arrive.`
          : apiMessage(err, endpoint === "grade" ? "Grade request failed." : "Re-run failed."),
      );
      void reload();
    } finally {
      setGrading(false);
    }
  }

  const handleGrade = (): Promise<void> => runBatch("grade");
  const handleRerunAll = (): Promise<void> => runBatch("rerun");

  // The accept body must carry the FULL GradingProposal objects (not ids).
  async function acceptProposals(list: Array<GradingProposal & { edits?: Record<string, unknown> }>): Promise<void> {
    setActing(true);
    await guard(async () => {
      await adminApi(`${apiBase}/accept`, { method: "POST", body: JSON.stringify({ proposals: list }) });
      onError(null);
      await reload();
    }, onError);
    setActing(false);
  }

  async function handleAcceptAll(): Promise<void> {
    if (acceptable.length === 0) {
      onError("No proposals ready to accept — all are AI failures. Re-run or override each one.");
      return;
    }
    await acceptProposals(acceptable);
  }

  // Re-run is a whole-attempt batch on the server (RERUN_BODY_SCHEMA is just
  // { forceEscalate }); keep the clicked question's Stage 3 result for the diff.
  async function handleRerun(questionId: string): Promise<void> {
    setGrading(true);
    try {
      const res = await adminApi<{ proposals: GradingProposal[] }>(`${apiBase}/rerun`, {
        method: "POST",
        body: JSON.stringify({ forceEscalate: true }),
      });
      const p = res.proposals.find((x) => x.question_id === questionId);
      if (p) {
        onError(null);
        setEscalationProposals((prev) => ({ ...prev, [questionId]: p }));
      }
    } catch (err) {
      onError(apiMessage(err, "Re-run failed."));
    } finally {
      setGrading(false);
    }
  }

  async function handleManualScore(q: FrozenQuestion, score: number, reason: string): Promise<void> {
    setActing(true);
    await guard(async () => {
      await adminApi(`${apiBase}/questions/${q.id}/manual-score`, {
        method: "POST",
        body: JSON.stringify({ score_earned: score, reason }),
      });
      setManualOpen((prev) => ({ ...prev, [q.id]: false }));
      onError(null);
      await reload();
    }, onError);
    setActing(false);
  }

  function openOverrideForm(questionId: string, g: GradingsRow): void {
    setOverrideForm({
      questionId,
      gradingId: g.id,
      band: g.reasoning_band,
      scoreMax: Number(g.score_max),
      justification: g.ai_justification ?? "",
      reason: "",
    });
  }

  async function handleOverrideSubmit(): Promise<void> {
    const f = overrideForm;
    if (!f.gradingId || f.band === null || f.scoreMax === null || !f.reason.trim()) return;
    setActing(true);
    await guard(async () => {
      try {
        await adminApi(`${apiBase}/gradings/${f.gradingId}/override`, {
          method: "POST",
          body: JSON.stringify({
            score_earned: bandToScore(f.band as number, f.scoreMax as number),
            reasoning_band: f.band,
            ai_justification: f.justification,
            reason: f.reason,
          }),
        });
      } catch (err) {
        // Tenant override races: the result was sent back, or already published.
        if (isErrorCode(err, "EVALUATION_NOT_RELEASED")) {
          setOverrideForm(EMPTY_OVERRIDE);
          onError("This result can't be changed right now — the evaluation hasn't been released to you, or it was sent back.");
          await reload();
          return;
        }
        if (isErrorCode(err, "RESULT_ALREADY_PUBLISHED")) {
          setOverrideForm(EMPTY_OVERRIDE);
          onError("This result has already been published to the candidate and can no longer be changed.");
          await reload();
          return;
        }
        throw err;
      }
      setOverrideForm(EMPTY_OVERRIDE);
      onError(null);
      await reload();
    }, onError);
    setActing(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const aiGradeableCount = frozen_questions.filter((q) => AI_GRADEABLE_TYPES.has(q.type)).length;
  const scoreEarned = [...effective.values()].reduce((s, g) => s + Number(g.score_earned ?? 0), 0);
  const scoreMax = [...effective.values()].reduce((s, g) => s + Number(g.score_max ?? 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
      {/* Evaluate toolbar: Grade all on a pre-graded attempt, Re-run AI on a sent-back one */}
      {(isGradeable || canRerunAi) && (
        <div className="aiq-no-print" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
            {isGradeable && (
              <button
                type="button"
                className={`aiq-btn ${pending.length === 0 ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                data-help-id="admin.attempts.grading_dispatch"
                disabled={grading || gradingActive}
                onClick={() => void handleGrade()}
                title={
                  gradingActive
                    ? "A grading run is already in progress on the server — wait for it to finish."
                    : gradingStalled
                      ? "Previous grading appears to have stalled (>10 min). Click to retry — the backend single-flight is fresh after a restart."
                      : undefined
                }
              >
                {grading || gradingActive ? "Grading…" : gradingStalled ? "Re-grade (previous stalled)" : "Grade all"}
              </button>
            )}
            {canRerunAi && (
              <button
                type="button"
                className={`aiq-btn ${pending.length === 0 ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                data-help-id="admin.evaluations.rerun_ai"
                disabled={grading || gradingActive}
                onClick={() => void handleRerunAll()}
                title={
                  gradingActive
                    ? "A re-run is already in progress on the server — wait for it to finish."
                    : gradingStalled
                      ? "The previous re-run appears to have stalled (>10 min). Click to retry — the backend single-flight is fresh after a restart."
                      : "Grade every written answer again. Nothing changes until you accept the new grades."
                }
              >
                {grading || gradingActive ? "Re-running…" : gradingStalled ? "Re-run AI (previous stalled)" : "Re-run AI"}
              </button>
            )}
            {acceptable.length > 0 && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary"
                data-help-id="admin.evaluations.accept_all"
                disabled={acting}
                onClick={() => void handleAcceptAll()}
              >
                {acting ? "Accepting…" : `Accept all (${acceptable.length})`}
              </button>
            )}
          </div>
          {acceptable.length > 0 && completesOnAction(acceptable.map((p) => p.question_id)) && (
            <ReleaseNotice tenantName={tenantName} action="Accepting the last grade" />
          )}
        </div>
      )}

      {stepUp}

      {/* Server-driven "grading in progress" banner: the page auto-polls every
          15 s while the marker is set and the banner clears on its own. */}
      {evaluate && gradingActive && (
        <div
          className="aiq-banner"
          data-help-id="admin.attempts.grading_in_progress"
          style={{ ...BANNER, backgroundColor: "var(--aiq-color-info-subtle, #eef4ff)", border: "1px solid var(--aiq-color-info, #3177dc)", color: "var(--aiq-color-info, #3177dc)" }}
        >
          <Spinner aria-label="Grading in progress" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Grading in progress on the server.</div>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", opacity: 0.85, marginTop: 2 }}>
              Started {gradingElapsedSec}s ago · polling every 15s · safe to navigate away — proposals will be here when you return.
            </div>
          </div>
          <button type="button" className="aiq-btn aiq-btn-sm aiq-btn-outline" onClick={() => void reload()}>
            Check now
          </button>
        </div>
      )}
      {evaluate && gradingStalled && (
        <div
          className="aiq-banner aiq-banner-warning"
          data-help-id="admin.attempts.grading_stalled"
          style={{ ...BANNER, backgroundColor: "var(--aiq-color-warning-subtle, #fff8e0)", border: "1px solid var(--aiq-color-warning, #b08000)", color: "var(--aiq-color-warning, #b08000)" }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Previous grading appears to have stalled.</div>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", opacity: 0.85, marginTop: 2 }}>
              Started {Math.floor(gradingElapsedSec / 60)} min ago — the API likely restarted mid-batch. Click <strong>Re-grade</strong> above to retry; the server's single-flight is fresh.
            </div>
          </div>
        </div>
      )}

      {/* Grading summary: how far along the attempt is + a pill per question. */}
      {(pending.length > 0 || effective.size > 0) && (
        <div className="aiq-card" data-help-id="admin.attempts.grading_summary" style={{ padding: "var(--aiq-space-md) var(--aiq-space-xl)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--aiq-space-xl)", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "var(--aiq-space-xl)", flexWrap: "wrap" }}>
              <div>
                <div style={MONO_LABEL}>Graded</div>
                <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-md)" }}>
                  {effective.size} of {frozen_questions.length} ({aiGradeableCount} AI-gradeable)
                </div>
              </div>
              {scoreMax > 0 && (
                <div>
                  <div style={MONO_LABEL}>Score</div>
                  <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-md)" }}>
                    {scoreEarned} / {scoreMax}
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              {frozen_questions.map((q, idx) => {
                const g = effective.get(q.id);
                const p = shown.get(q.id);
                let label: string;
                let bg: string;
                let fg: string;
                if (g && g.status === "review_needed") {
                  label = `Q${idx + 1} needs review`;
                  bg = "var(--aiq-color-danger-subtle, #fff0f0)";
                  fg = "var(--aiq-color-danger)";
                } else if (g && p) {
                  // graded, with a fresh re-run result waiting for a decision
                  label = `Q${idx + 1} re-run ready`;
                  bg = "var(--aiq-color-warning-subtle, #fff8e0)";
                  fg = "var(--aiq-color-warning, #b08000)";
                } else if (g) {
                  label = `Q${idx + 1} graded`;
                  bg = "var(--aiq-color-success-subtle, #e8f5ec)";
                  fg = "var(--aiq-color-success, #2a8a4a)";
                } else if (p && isAiFailure(p)) {
                  label = `Q${idx + 1} needs review`;
                  bg = "var(--aiq-color-danger-subtle, #fff0f0)";
                  fg = "var(--aiq-color-danger)";
                } else if (p) {
                  label = `Q${idx + 1} ready`;
                  bg = "var(--aiq-color-warning-subtle, #fff8e0)";
                  fg = "var(--aiq-color-warning, #b08000)";
                } else {
                  label = `Q${idx + 1} pending`;
                  bg = "transparent";
                  fg = "var(--aiq-color-fg-muted)";
                }
                return (
                  <span key={q.id} title={label} style={{ ...PILL, textTransform: "none", letterSpacing: 0, padding: "2px 8px", border: `1px solid ${fg}`, backgroundColor: bg, color: fg }}>
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Questions — each a four-zone audit card. */}
      {frozen_questions.map((q, idx) => {
        const answer = answers.find((a) => a.question_id === q.id);
        const existing = effective.get(q.id);
        const proposal = shown.get(q.id);
        const escalation = proposal ? escalationProposals[q.id] : undefined;
        const manualShown = manualOpen[q.id] ?? q.type === "kql";

        let stLabel: string;
        let stBg: string;
        let stFg: string;
        if (existing && existing.status === "review_needed") {
          stLabel = "needs review";
          stBg = "var(--aiq-color-danger-subtle, #fff0f0)";
          stFg = "var(--aiq-color-danger)";
        } else if (existing && proposal) {
          stLabel = "re-run ready";
          stBg = "var(--aiq-color-warning-subtle, #fff8e0)";
          stFg = "var(--aiq-color-warning, #b08000)";
        } else if (existing) {
          stLabel = "graded";
          stBg = "var(--aiq-color-success-subtle, #e8f5ec)";
          stFg = "var(--aiq-color-success, #2a8a4a)";
        } else if (proposal && isAiFailure(proposal)) {
          stLabel = "needs review";
          stBg = "var(--aiq-color-danger-subtle, #fff0f0)";
          stFg = "var(--aiq-color-danger)";
        } else if (proposal) {
          stLabel = "ready to accept";
          stBg = "var(--aiq-color-warning-subtle, #fff8e0)";
          stFg = "var(--aiq-color-warning, #b08000)";
        } else {
          stLabel = "not graded";
          stBg = "transparent";
          stFg = "var(--aiq-color-fg-muted)";
        }

        return (
          <div
            key={q.id}
            className="aiq-card aiq-admin-detail-question"
            style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}
          >
            {/* Header: question index + type + points + status pill */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
              <div style={MONO_LABEL}>
                Q{idx + 1} · {q.type} · {q.points} pts
              </div>
              <span style={{ ...PILL, border: `1px solid ${stFg}`, backgroundColor: stBg, color: stFg }}>{stLabel}</span>
            </div>

            {/* ZONE 1 — Question (candidate-facing prompt only, no answer key) */}
            <div>
              <div style={{ ...ZONE_LABEL_STYLE, color: "var(--aiq-color-fg-muted)" }}>
                <span aria-hidden="true">❓</span>
                <span>Question</span>
              </div>
              <QuestionPromptView type={q.type} content={q.content} />
            </div>

            {/* ZONE 2 — Expected answer / rubric (the grading ground-truth) */}
            <AuditZone label="Expected answer / rubric" icon="✦" accent="var(--aiq-color-info, #3177dc)">
              <ExpectedAnswerView type={q.type} content={q.content} rubric={q.rubric ?? null} />
            </AuditZone>

            {/* ZONE 3 — Candidate answer (what was submitted) */}
            <AuditZone label="Candidate answer" icon="✎" accent="var(--aiq-color-fg-secondary)">
              {answer ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                  <AttemptAnswerView type={q.type} content={q.content} answer={answer.answer} />
                  {/* Rubric-concept coverage highlighting — only for narrative
                      types with a rubric whose anchors pair with the grading's
                      anchor_hits. */}
                  {existing?.anchor_hits && q.rubric?.anchors && q.rubric.anchors.length > 0 && (() => {
                    const answerText = serializeAnswerForCoverage(q.type, answer.answer);
                    if (!answerText) return null;
                    const hitById = new Map((existing.anchor_hits ?? []).map((a) => [a.anchor_id, a]));
                    const anchors = q.rubric.anchors.map((rA) => {
                      const finding = hitById.get(rA.id);
                      return {
                        id: rA.id,
                        concept: rA.concept,
                        weight: rA.weight,
                        ...(rA.synonyms ? { synonyms: rA.synonyms } : {}),
                        hit: finding?.hit === true,
                        ...(finding?.evidence_quote ? { evidence_quote: finding.evidence_quote } : {}),
                      };
                    });
                    return <ConceptCoverageView answerText={answerText} anchors={anchors} data-test-id={`coverage-${q.id}`} />;
                  })()}
                </div>
              ) : (
                <NoAnswer label="No answer submitted." />
              )}
            </AuditZone>

            {/* ZONE 4 — Evaluation (grade, anchor evidence, justification, controls) */}
            <AuditZone label="Evaluation" icon="✓" accent="var(--aiq-color-accent, #3177dc)">
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                {existing && (
                  <ScoreDetail
                    grading={existing}
                    questionLabel={evaluate ? "Current grade" : "Final grade"}
                    showAnchorEvidence
                    {...(q.rubric?.anchors ? { rubricAnchors: q.rubric.anchors } : {})}
                  />
                )}

                {!existing && !proposal && (
                  <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontStyle: "italic", color: "var(--aiq-color-fg-muted)" }}>
                    {isGradeable
                      ? q.type === "kql"
                        ? "Not yet scored — enter a score below."
                        : "Not yet graded — click “Grade all” above to generate a proposal."
                      : "Not graded."}
                  </p>
                )}

                {/* Override form (existing grading only) */}
                {canOverride && existing && overrideForm.questionId === q.id ? (
                  <div className="aiq-card aiq-no-print" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)", border: "1px solid var(--aiq-color-border)" }}>
                    <span style={MONO_LABEL}>Override grade (requires fresh MFA)</span>
                    <BandPicker value={overrideForm.band} onChange={(b) => setOverrideForm((f) => ({ ...f, band: b }))} />
                    <label data-help-id="admin.grading.override.reason" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                      <span style={MONO_LABEL}>Override reason (required)</span>
                      <textarea
                        className="aiq-admin-longform-textarea"
                        rows={2}
                        value={overrideForm.reason}
                        onChange={(e) => setOverrideForm((f) => ({ ...f, reason: e.target.value }))}
                        style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", resize: "vertical" }}
                      />
                    </label>
                    {completesOnAction([q.id]) && (
                      <ReleaseNotice tenantName={tenantName} action="Saving this override" />
                    )}
                    <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-primary aiq-btn-sm"
                        disabled={acting || overrideForm.band === null || !overrideForm.reason.trim()}
                        onClick={() => void handleOverrideSubmit()}
                      >
                        Submit override
                      </button>
                      <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setOverrideForm(EMPTY_OVERRIDE)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  canOverride &&
                  existing && (
                    <div>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-outline aiq-btn-sm aiq-no-print"
                        onClick={() => openOverrideForm(q.id, existing)}
                      >
                        Override grade
                      </button>
                    </div>
                  )
                )}

                {/* Fresh AI proposal (evaluate mode). On a graded question it is a RE-RUN result
                    that is newer than the grade above: accepting it replaces that grade. */}
                {proposal && existing && (
                  <p className="aiq-no-print" style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>
                    New AI result from the re-run. Accepting it replaces the current grade above; Override lets you set your own score instead.
                  </p>
                )}
                {proposal && !isAiFailure(proposal) && completesOnAction([q.id]) && (
                  <ReleaseNotice tenantName={tenantName} action="Accepting the last grade" />
                )}
                {proposal && (
                  <GradingProposalCard
                    proposal={proposal}
                    submitting={acting || grading}
                    onAccept={() => void acceptProposals([proposal])}
                    onOverride={() =>
                      existing && canOverride
                        ? openOverrideForm(q.id, existing)
                        : setManualOpen((m) => ({ ...m, [q.id]: true }))
                    }
                    // The per-question Opus re-run is the pre-graded helper; a sent-back attempt
                    // has the attempt-level "Re-run AI" in the toolbar instead.
                    {...(canRerunAi ? {} : { onRerun: () => void handleRerun(q.id) })}
                  />
                )}

                {/* Escalation diff (Stage 2 vs Stage 3) */}
                {proposal && escalation && (
                  <EscalationDiff
                    stageTwo={proposal}
                    stageThree={escalation}
                    submitting={acting}
                    onReconcile={(stage, note) => {
                      // The chosen proposal carries its own escalation_chosen_stage;
                      // the reconcile note travels in `edits`.
                      const chosen = { ...(stage === "3" ? escalation : proposal), escalation_chosen_stage: stage };
                      void acceptProposals([
                        { ...chosen, edits: { ai_justification: note + "\n\n[Reconciled: " + note + "]" } },
                      ]);
                    }}
                  />
                )}

                {/* Manual score: no grade yet (KQL, or the evaluator skips the AI proposal) */}
                {evaluate && !existing &&
                  (manualShown ? (
                    <ManualScoreForm
                      max={q.points}
                      busy={acting}
                      onSubmit={(score, reason) => void handleManualScore(q, score, reason)}
                      releaseNotice={
                        completesOnAction([q.id]) ? (
                          <ReleaseNotice tenantName={tenantName} action="Saving the last score" />
                        ) : undefined
                      }
                      {...(q.type === "kql" ? {} : { onCancel: () => setManualOpen((m) => ({ ...m, [q.id]: false })) })}
                    />
                  ) : (
                    !proposal && (
                      <div>
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-ghost aiq-btn-sm aiq-no-print"
                          onClick={() => setManualOpen((m) => ({ ...m, [q.id]: true }))}
                        >
                          Score manually
                        </button>
                      </div>
                    )
                  ))}
              </div>
            </AuditZone>
          </div>
        );
      })}

      {/* Print stylesheet: hides nav / buttons / banners / proposals while
          keeping question content, answers, score details and the summary. */}
      <style>{`
        @media print {
          /* The error banner is NOT hidden — operational errors are part of the
             audit context if the admin prints mid-error state. */
          .aiq-no-print,
          .aiq-banner:not(.aiq-error-banner),
          .aiq-shell-nav,
          .aiq-shell-sidebar,
          nav,
          [data-help-id="admin.attempts.grading_in_progress"],
          [data-help-id="admin.attempts.grading_stalled"] {
            display: none !important;
          }
          .aiq-admin-detail-question {
            page-break-inside: avoid;
          }
          .aiq-card {
            box-shadow: none !important;
            border: 1px solid #ddd !important;
            page-break-inside: avoid;
          }
          body, .aiq-shell-main {
            background: white !important;
            color: black !important;
          }
        }
      `}</style>
    </div>
  );
}

AttemptGradingPanel.displayName = "AttemptGradingPanel";
