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
import { AdminShell } from "../components/AdminShell.js";
import { GradingProposalCard } from "../components/GradingProposalCard.js";
import { EscalationDiff } from "../components/EscalationDiff.js";
import { ScoreDetail } from "../components/ScoreDetail.js";
import { BandPicker } from "../components/BandPicker.js";
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

function QuestionContent({ content }: { content: unknown }): React.ReactElement {
  // Render question content as pre-wrapped plain text — no dangerouslySetInnerHTML.
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return (
    <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-primary)" }}>
      {text}
    </p>
  );
}

function AnswerContent({ answer }: { answer: unknown }): React.ReactElement {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer, null, 2);
  return (
    <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)", borderLeft: "2px solid var(--aiq-color-border)", paddingLeft: "var(--aiq-space-md)" }}>
      {text}
    </p>
  );
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
      setProposals(map);
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.apiError.message : "Grade request failed.";
      setError(msg);
    } finally {
      setGrading(false);
    }
  }

  async function handleAccept(questionId: string, proposal: GradingProposal) {
    if (!id) return;
    setAccepting(true);
    try {
      await adminApi(`/admin/attempts/${id}/accept`, {
        method: "POST",
        body: JSON.stringify({ question_id: questionId }),
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
      <AdminShell breadcrumbs={["Attempts", "Detail"]} helpPage="admin.attempts.detail">
        <div style={{ padding: "var(--aiq-space-3xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>
          Loading…
        </div>
      </AdminShell>
    );
  }

  if (error || !detail) {
    return (
      <AdminShell breadcrumbs={["Attempts", "Detail"]} helpPage="admin.attempts.detail">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const { attempt, answers, frozen_questions, gradings } = detail;
  const isGradeable = attempt.status === "submitted" || attempt.status === "pending_admin_grading";

  return (
    <AdminShell breadcrumbs={["Attempts", attempt.id.slice(0, 8)]} helpPage="admin.attempts.detail">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-2xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.015em" }}>
              {attempt.assessment_name}
            </h1>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginTop: "var(--aiq-space-xs)" }}>
              {attempt.candidate_email} · {attempt.level_label} · {attempt.status}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
            {isGradeable && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary"
                disabled={grading}
                onClick={() => void handleGrade()}
              >
                {grading ? "Grading…" : "Grade all"}
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
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {error}
          </div>
        )}

        {/* Questions */}
        {frozen_questions.map((q) => {
          const answer = answers.find((a) => a.question_id === q.id);
          const proposal = proposals[q.id];
          const escalation = escalationProposals[q.id];
          const existingGrading = gradings.find((g) => g.question_id === q.id && !g.override_of);

          return (
            <div
              key={q.id}
              className="aiq-card"
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-xl)", padding: "var(--aiq-space-xl)" }}
            >
              {/* Left: question + answer */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                  {q.type} · {q.points} pts
                </div>
                <QuestionContent content={q.content} />
                {answer && (
                  <>
                    <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                      Candidate answer
                    </div>
                    <AnswerContent answer={answer.answer} />
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
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                        Override reason (required)
                      </span>
                      <textarea
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
                      const chosenProposal = stage === "3" ? escalation : proposal;
                      void adminApi(`/admin/attempts/${id}/accept`, {
                        method: "POST",
                        body: JSON.stringify({
                          question_id: q.id,
                          edits: { escalation_chosen_stage: stage, ai_justification: note + "\n\n[Reconciled: " + note + "]" },
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
