// AssessIQ — Admin attempt detail page.
//
// /admin/attempts/:id
//
// P2.D15: loading this page triggers submitted→pending_admin_grading transition
// via GET /admin/attempts/:id (which calls handleAdminClaimAttempt).
//
// Layout: two-column.
//  Left: question content + candidate answer (plain text, sanitized).
//  Right: GradingProposalCard / BandPicker override / EscalationDiff.
//
// Actions:
//  - Grade: POST /admin/attempts/:id/grade → returns proposal
//  - Accept: POST /admin/attempts/:id/accept → commits grading row
//  - Override: POST /admin/gradings/:id/override (freshMFA gated)
//  - Re-run: POST /admin/attempts/:id/rerun (returns new proposals)
//  - Release: POST /admin/attempts/:id/release (terminal)
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - ai_justification + candidate answer displayed as plain text only.
//  - Override requires fresh-MFA; if 401 with code FRESH_MFA_REQUIRED,
//    redirect to /admin/mfa?return=<current-path>.

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chip, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { GradingProposalCard } from "../components/GradingProposalCard.js";
import { EscalationDiff } from "../components/EscalationDiff.js";
import { ScoreDetail } from "../components/ScoreDetail.js";
import { BandPicker } from "../components/BandPicker.js";
import { QuestionContentView } from "../components/QuestionContentView.js";
import { adminApi, AdminApiError } from "../api.js";
import type { GradingProposal, GradingsRow } from "@assessiq/ai-grading";

// ---------------------------------------------------------------------------
// Types for the attempt detail endpoint response
// ---------------------------------------------------------------------------

interface AttemptAnswer {
  question_id: string;
  answer: unknown;
  edits_count?: number;
}

interface FrozenQuestion {
  id: string;
  type: string;
  content: unknown;
  points: number;
  rubric?: unknown;
}

interface AttemptDetailResponse {
  attempt: {
    id: string;
    status: string;
    started_at: string;
    submitted_at: string | null;
    candidate_email: string;
    assessment_name: string;
    level_label: string;
  };
  answers: AttemptAnswer[];
  frozen_questions: FrozenQuestion[];
  gradings: GradingsRow[];
}

interface OverrideFormState {
  questionId: string | null;
  gradingId: string | null;
  band: number | null;
  justification: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Candidate-answer renderer
//
// Maps each canonical answer shape (mirrors the take-flow shapes in
// modules/11-candidate-ui Attempt.tsx) to a human-readable layout. It must
// NEVER dump raw JSON to the admin — unrecognised shapes fall back to a plain
// "no preview" message rather than brace-and-quote text. The question content
// itself is rendered by the shared <QuestionContentView>, which already
// strips JSON-escape + markdown noise and shows the correct option / rationale.
// ---------------------------------------------------------------------------

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

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];

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

export function AdminAttemptDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<AttemptDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-question proposal state (keyed by question_id)
  const [proposals, setProposals] = useState<Record<string, GradingProposal>>({});
  // Re-run escalation proposals (keyed by question_id) — Stage-3 results
  const [escalationProposals, setEscalationProposals] = useState<Record<string, GradingProposal>>({});
  const [grading, setGrading] = useState(false);
  const [overrideForm, setOverrideForm] = useState<OverrideFormState>({ questionId: null, gradingId: null, band: null, justification: "", reason: "" });
  const [accepting, setAccepting] = useState(false);
  const [overriding, setOverriding] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<AttemptDetailResponse>(`/admin/attempts/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load attempt.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function handleGrade() {
    if (!id) return;
    setGrading(true);
    try {
      const res = await adminApi<{ proposals: GradingProposal[] }>(
        `/admin/attempts/${id}/grade`,
        { method: "POST" },
      );
      const map: Record<string, GradingProposal> = {};
      for (const p of res.proposals) map[p.question_id] = p;
      setError(null);
      setProposals(map);
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.apiError.message : "Grade request failed.";
      setError(msg);
    } finally {
      setGrading(false);
    }
  }

  // Bug A fix (2026-05-28): the backend ACCEPT_BODY_SCHEMA (routes.ts:116-118)
  // requires `{ proposals: [ …full GradingProposal objects… ] }`. The previous
  // body `{ question_id }` silently 422'd and grades never persisted —
  // RCA_LOG entry "Accept never persisted grades".
  async function handleAccept(questionId: string, proposal: GradingProposal) {
    if (!id) return;
    setAccepting(true);
    try {
      await adminApi(`/admin/attempts/${id}/accept`, {
        method: "POST",
        body: JSON.stringify({ proposals: [proposal] }),
      });
      await load();
      setProposals((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Accept failed.");
    } finally {
      setAccepting(false);
    }
  }

  // AI-failure detection: proposals built by the failed-proposal branch in
  // admin-grade.ts:413-432 carry these tells. We skip them in Accept-all so
  // a runtime failure never auto-commits a score-0 row; the admin must
  // explicitly Re-run or Override each one.
  function isAiFailure(p: GradingProposal): boolean {
    if (p.model === "none") return true;
    if (p.prompt_version_sha === "error:no-sha") return true;
    const ec = p.band.error_class;
    if (typeof ec === "string" && ec.startsWith("AIG_")) return true;
    return false;
  }

  async function handleAcceptAll() {
    if (!id) return;
    const all = Object.values(proposals);
    const acceptable = all.filter((p) => !isAiFailure(p));
    if (acceptable.length === 0) {
      setError(
        "No proposals ready to accept — all are AI failures. Re-run or override each one.",
      );
      return;
    }
    setAccepting(true);
    try {
      await adminApi(`/admin/attempts/${id}/accept`, {
        method: "POST",
        body: JSON.stringify({ proposals: acceptable }),
      });
      await load();
      setProposals((prev) => {
        const next = { ...prev };
        for (const p of acceptable) delete next[p.question_id];
        return next;
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Accept all failed.");
    } finally {
      setAccepting(false);
    }
  }

  async function handleOverrideSubmit() {
    if (!overrideForm.gradingId || overrideForm.band === null || !overrideForm.reason.trim()) return;
    setOverriding(true);
    try {
      await adminApi(`/admin/gradings/${overrideForm.gradingId}/override`, {
        method: "POST",
        body: JSON.stringify({
          score_earned: overrideForm.band * 25,
          reasoning_band: overrideForm.band,
          ai_justification: overrideForm.justification,
          reason: overrideForm.reason,
        }),
      });
      setOverrideForm({ questionId: null, gradingId: null, band: null, justification: "", reason: "" });
      await load();
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        // Fresh-MFA required — redirect to /admin/mfa then back
        const returnPath = encodeURIComponent(window.location.pathname);
        navigate(`/admin/mfa?return=${returnPath}`);
        return;
      }
      setError(err instanceof AdminApiError ? err.apiError.message : "Override failed.");
    } finally {
      setOverriding(false);
    }
  }

  async function handleRerun(questionId: string) {
    if (!id) return;
    setGrading(true);
    try {
      const res = await adminApi<{ proposals: GradingProposal[] }>(
        `/admin/attempts/${id}/rerun?escalate=opus`,
        { method: "POST", body: JSON.stringify({ question_id: questionId }) },
      );
      const p = res.proposals.find((p) => p.question_id === questionId);
      if (p) {
        setError(null);
        setEscalationProposals((prev) => ({ ...prev, [questionId]: p }));
      }
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Re-run failed.");
    } finally {
      setGrading(false);
    }
  }

  async function handleRelease() {
    if (!id || !detail) return;
    if (!window.confirm(`Release attempt to candidate ${detail.attempt.candidate_email}?`)) return;
    try {
      await adminApi(`/admin/attempts/${id}/release`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Release failed.");
    }
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={[{ label: "Attempts", href: "/admin/attempts" }, "Detail"]} helpPage="admin.attempts.detail">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading attempt" />
        </div>
      </AdminShell>
    );
  }

  if (!detail) {
    return (
      <AdminShell breadcrumbs={[{ label: "Attempts", href: "/admin/attempts" }, "Detail"]} helpPage="admin.attempts.detail">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const { attempt, answers, frozen_questions, gradings } = detail;
  const isGradeable = attempt.status === "submitted" || attempt.status === "pending_admin_grading";

  return (
    <AdminShell breadcrumbs={[{ label: "Attempts", href: "/admin/attempts" }, attempt.id.slice(0, 8)]} helpPage="admin.attempts.detail">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip>{attempt.status.replace(/_/g, " ")}</Chip>
            </div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              {attempt.assessment_name}.
            </h1>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginTop: "var(--aiq-space-xs)" }}>
              {attempt.candidate_email} · {attempt.level_label}{attempt.submitted_at ? ` · ${new Date(attempt.submitted_at).toLocaleString()}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
            {isGradeable && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary"
                data-help-id="admin.attempts.grading_dispatch"
                disabled={grading}
                onClick={() => void handleGrade()}
              >
                {grading ? "Grading…" : "Grade all"}
              </button>
            )}
            {isGradeable && Object.values(proposals).some((p) => !isAiFailure(p)) && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary"
                data-help-id="admin.attempts.accept_all"
                disabled={accepting}
                onClick={() => void handleAcceptAll()}
              >
                {accepting
                  ? "Accepting…"
                  : `Accept all (${Object.values(proposals).filter((p) => !isAiFailure(p)).length})`}
              </button>
            )}
            {attempt.status === "graded" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
                onClick={() => void handleRelease()}
              >
                Release to candidate
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="aiq-banner aiq-banner-error" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md) var(--aiq-space-xl)", backgroundColor: "var(--aiq-color-danger-subtle, #fff0f0)", border: "1px solid var(--aiq-color-danger)", borderRadius: "var(--aiq-radius-sm, 4px)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              type="button"
              className="aiq-btn aiq-btn-sm"
              style={{ flexShrink: 0 }}
              onClick={() => { setError(null); void load(); }}
            >
              Refresh
            </button>
            <button
              type="button"
              className="aiq-btn aiq-btn-sm aiq-btn-outline"
              style={{ flexShrink: 0 }}
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Grading summary — Bug A Phase 1: surface gate progress + per-question
            status so the admin knows why an attempt isn't completing. */}
        {(Object.keys(proposals).length > 0 || gradings.length > 0) && (() => {
          const aiGradeableTypes = new Set(["subjective", "scenario", "log_analysis"]);
          const aiGradeableCount = frozen_questions.filter((q) => aiGradeableTypes.has(q.type)).length;
          const acceptedDistinct = new Set(
            gradings.filter((g) => !g.override_of).map((g) => g.question_id),
          ).size;
          const scoreEarned = gradings
            .filter((g) => !g.override_of)
            .reduce((s, g) => s + Number(g.score_earned ?? 0), 0);
          const scoreMax = gradings
            .filter((g) => !g.override_of)
            .reduce((s, g) => s + Number(g.score_max ?? 0), 0);
          return (
            <div className="aiq-card" data-help-id="admin.attempts.grading_summary" style={{ padding: "var(--aiq-space-md) var(--aiq-space-xl)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--aiq-space-xl)", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "var(--aiq-space-xl)", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                      Graded
                    </div>
                    <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-md)" }}>
                      {acceptedDistinct} of {frozen_questions.length} ({aiGradeableCount} AI-gradeable)
                    </div>
                  </div>
                  {scoreMax > 0 && (
                    <div>
                      <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                        Score
                      </div>
                      <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-md)" }}>
                        {scoreEarned} / {scoreMax}
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                  {frozen_questions.map((q, idx) => {
                    const g = gradings.find((gg) => gg.question_id === q.id && !gg.override_of);
                    const p = proposals[q.id];
                    let label: string;
                    let bg: string;
                    let fg: string;
                    if (g) {
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
                      <span
                        key={q.id}
                        title={label}
                        style={{
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          padding: "2px 8px",
                          borderRadius: "var(--aiq-radius-pill, 999px)",
                          border: `1px solid ${fg}`,
                          backgroundColor: bg,
                          color: fg,
                        }}
                      >
                        {label}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Questions */}
        {frozen_questions.map((q) => {
          const answer = answers.find((a) => a.question_id === q.id);
          const proposal = proposals[q.id];
          const escalation = escalationProposals[q.id];
          const existingGrading = gradings.find((g) => g.question_id === q.id && !g.override_of);

          return (
            <div
              key={q.id}
              className="aiq-card aiq-admin-detail-two-col"
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-xl)", padding: "var(--aiq-space-xl)" }}
            >
              {/* Left: question + answer */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                  {q.type} · {q.points} pts
                </div>
                <QuestionContentView type={q.type} content={q.content} />
                {answer && (
                  <>
                    <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                      Candidate answer
                    </div>
                    <AttemptAnswerView type={q.type} content={q.content} answer={answer.answer} />
                  </>
                )}
              </div>

              {/* Right: grading panel */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                {/* Existing grading */}
                {existingGrading && (
                  <ScoreDetail
                    grading={existingGrading}
                    questionLabel="Current grade"
                  />
                )}

                {/* Override form */}
                {existingGrading && overrideForm.questionId === q.id ? (
                  <div className="aiq-card" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)", border: "1px solid var(--aiq-color-border)" }}>
                    <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                      Override grade (requires fresh MFA)
                    </span>
                    <BandPicker value={overrideForm.band} onChange={(b) => setOverrideForm((f) => ({ ...f, band: b }))} />
                    <label data-help-id="admin.grading.override.reason" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                        Override reason (required)
                      </span>
                      <textarea
                        className="aiq-admin-longform-textarea"
                        rows={2}
                        value={overrideForm.reason}
                        onChange={(e) => setOverrideForm((f) => ({ ...f, reason: e.target.value }))}
                        style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", resize: "vertical" }}
                      />
                    </label>
                    <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                      <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={overriding || overrideForm.band === null || !overrideForm.reason.trim()} onClick={() => void handleOverrideSubmit()}>
                        Submit override
                      </button>
                      <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setOverrideForm({ questionId: null, gradingId: null, band: null, justification: "", reason: "" })}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : existingGrading && (
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-outline aiq-btn-sm"
                    onClick={() => setOverrideForm({ questionId: q.id, gradingId: existingGrading.id, band: existingGrading.reasoning_band, justification: existingGrading.ai_justification ?? "", reason: "" })}
                  >
                    Override grade
                  </button>
                )}

                {/* Fresh proposal from Grade button */}
                {proposal && !existingGrading && (
                  <GradingProposalCard
                    proposal={proposal}
                    submitting={accepting}
                    onAccept={() => void handleAccept(q.id, proposal)}
                    onOverride={() => setOverrideForm({ questionId: q.id, gradingId: null, band: proposal.band.reasoning_band, justification: proposal.band.ai_justification, reason: "" })}
                    onRerun={() => void handleRerun(q.id)}
                  />
                )}

                {/* Escalation diff (Stage 2 vs Stage 3) */}
                {proposal && escalation && proposal.question_id === escalation.question_id && (
                  <EscalationDiff
                    stageTwo={proposal}
                    stageThree={escalation}
                    onReconcile={(stage, note) => {
                      // Bug A escalation-accept fix: send {proposals: [chosen]}
                      // with edits carrying the reconcile note. The chosen
                      // proposal's own escalation_chosen_stage carries the
                      // stage marker (the edits schema doesn't carry that
                      // field — it lives on the proposal itself).
                      const chosenProposal = {
                        ...(stage === "3" ? escalation : proposal),
                        escalation_chosen_stage: stage,
                      };
                      void adminApi(`/admin/attempts/${id}/accept`, {
                        method: "POST",
                        body: JSON.stringify({
                          proposals: [{
                            ...chosenProposal,
                            edits: {
                              ai_justification: note + "\n\n[Reconciled: " + note + "]",
                            },
                          }],
                        }),
                      }).then(() => void load());
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </AdminShell>
  );
}
