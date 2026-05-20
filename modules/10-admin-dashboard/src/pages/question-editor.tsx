// AssessIQ — Admin question editor page.
//
// /admin/question-bank/questions/:id
// /admin/question-bank/questions/new?pack_id=...&level_id=...
//
// When id === "new": renders a create form (POST /api/admin/questions).
// Otherwise: renders rubric editor for an existing question.
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - Question content shown as plain text only.
//  - Rubric changes never auto-save — explicit "Save rubric" button only.

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { RubricEditor } from "../components/RubricEditor.js";
import type { RubricDraft, BandDraft } from "../components/RubricEditor.js";
import { QuestionContentView } from "../components/QuestionContentView.js";
import { adminApi, AdminApiError } from "../api.js";

const QUESTION_TYPES = ["mcq", "subjective", "kql", "scenario", "log_analysis"] as const;
type QuestionType = typeof QUESTION_TYPES[number];

const DEFAULT_CONTENT: Record<QuestionType, unknown> = {
  mcq: { question: "", options: ["", "", "", ""], correct: 0, rationale: "" },
  subjective: { question: "" },
  kql: { question: "", tables: [""], expected_keywords: [""] },
  scenario: { title: "", intro: "", steps: [], step_dependency: "linear" },
  log_analysis: { question: "", log_excerpt: "", log_format: "syslog", expected_findings: [""] },
};

interface QuestionDetail {
  id: string;
  type: string;
  status: string;
  points: number;
  content: unknown;
  rubric: unknown;
  assessment_name?: string;
  level_label?: string;
}

function _parseRubric(raw: unknown): RubricDraft {
  if (!raw || typeof raw !== "object") return { anchors: [], bands: [] };
  const r = raw as Record<string, unknown>;
  return {
    anchors: Array.isArray(r.anchors) ? r.anchors : [],
    bands: Array.isArray(r.bands) ? r.bands : [],
  };
}

// Server Rubric → editor RubricDraft
function rubricToRubricDraft(rubric: unknown): RubricDraft {
  if (!rubric || typeof rubric !== "object") return { anchors: [], bands: [] };
  const r = rubric as Record<string, unknown>;
  const serverAnchors = Array.isArray(r.anchors) ? r.anchors as Array<Record<string, unknown>> : [];
  const anchors = serverAnchors.map((a) => ({
    anchor_id: typeof a.id === "string" ? a.id : crypto.randomUUID(),
    phrase: typeof a.concept === "string" ? a.concept : "",
    synonyms: Array.isArray(a.synonyms) ? a.synonyms as string[] : [],
    weight: typeof a.weight === "number" ? a.weight / 100 : 0,
    required: false,
  }));
  const rb = (r.reasoning_bands && typeof r.reasoning_bands === "object") ? r.reasoning_bands as Record<string, string> : {};
  const bands: BandDraft[] = [4, 3, 2, 1, 0].map((band) => ({
    band,
    label: `Band ${band}`,
    description: typeof rb[`band_${band}`] === "string" ? rb[`band_${band}`] as string : "",
  }));
  return { anchors, bands };
}

// Editor RubricDraft → server Rubric canonical shape
function draftToRubric(draft: RubricDraft, reasoningWeight: number): unknown {
  const anchorWeightTotal = Math.round(draft.anchors.reduce((s, a) => s + a.weight * 100, 0));
  const reasoning_weight_total = reasoningWeight;
  const reasoning_bands: Record<string, string> = {};
  for (const band of draft.bands) {
    reasoning_bands[`band_${band.band}`] = band.description;
  }
  return {
    anchors: draft.anchors.map((a) => ({
      id: a.anchor_id,
      concept: a.phrase,
      weight: Math.round(a.weight * 100),
      synonyms: a.synonyms,
    })),
    reasoning_bands,
    anchor_weight_total: anchorWeightTotal,
    reasoning_weight_total,
  };
}

interface RubricProposal {
  proposal: unknown;
  skillSha: string;
  promptSha: string;
  levelDefaultsHash: string;
  model: string;
}

// Shimmer skeleton shown while AI rubric generation is in progress
function RubricSkeleton(): React.ReactElement {
  return (
    <>
      <style>{`
        @keyframes aiq-shimmer {
          0% { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        .aiq-skeleton-line {
          background: linear-gradient(90deg, var(--aiq-color-bg-secondary, #f0f0f0) 25%, var(--aiq-color-bg-tertiary, #e0e0e0) 50%, var(--aiq-color-bg-secondary, #f0f0f0) 75%);
          background-size: 800px 100%;
          animation: aiq-shimmer 1.4s infinite;
          border-radius: 4px;
          height: 14px;
          margin-bottom: 8px;
        }
      `}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="aiq-skeleton-line" style={{ width: "40%" }} />
            <div className="aiq-skeleton-line" style={{ width: "70%" }} />
            <div className="aiq-skeleton-line" style={{ width: "55%" }} />
          </div>
        ))}
        {[0, 1, 2, 3, 4].map((b) => (
          <div key={b} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="aiq-skeleton-line" style={{ width: "25%" }} />
            <div className="aiq-skeleton-line" style={{ width: "85%" }} />
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Create form — shown when id === "new"
// ---------------------------------------------------------------------------

function CreateQuestionForm({ packId, levelId }: { packId: string; levelId: string }): React.ReactElement {
  const navigate = useNavigate();
  const [type, setType] = useState<QuestionType>("mcq");
  const [topic, setTopic] = useState("");
  const [points, setPoints] = useState("5");
  const [contentJson, setContentJson] = useState(() => JSON.stringify(DEFAULT_CONTENT["mcq"], null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleTypeChange(t: QuestionType) {
    setType(t);
    setContentJson(JSON.stringify(DEFAULT_CONTENT[t], null, 2));
    setJsonError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setJsonError(null);
    setSubmitError(null);

    let content: unknown;
    try {
      content = JSON.parse(contentJson) as unknown;
    } catch {
      setJsonError("Content is not valid JSON.");
      return;
    }

    const pointsNum = parseInt(points, 10);
    if (isNaN(pointsNum) || pointsNum < 1) {
      setSubmitError("Points must be a positive integer.");
      return;
    }
    if (!topic.trim()) {
      setSubmitError("Topic is required.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await adminApi<{ id: string }>("/admin/questions", {
        method: "POST",
        body: JSON.stringify({ pack_id: packId, level_id: levelId, type, topic: topic.trim(), points: pointsNum, content }),
      });
      navigate(`/admin/question-bank/questions/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof AdminApiError ? err.apiError.message : "Failed to create question.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell breadcrumbs={["Question Bank", "New question"]} helpPage="admin.question.editor">
      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)", maxWidth: 640 }}>
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
          New question.</h1>

        {submitError && (
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {submitError}
          </div>
        )}

        <div className="aiq-form-group">
          <label className="aiq-label" htmlFor="q-type">Type *</label>
          <select
            id="q-type"
            className="aiq-input"
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as QuestionType)}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div className="aiq-form-group">
          <label className="aiq-label" htmlFor="q-topic">Topic *</label>
          <input
            id="q-topic"
            className="aiq-input"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. alert-triage"
            required
          />
        </div>

        <div className="aiq-form-group">
          <label className="aiq-label" htmlFor="q-points">Points *</label>
          <input
            id="q-points"
            className="aiq-input"
            type="number"
            min={1}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            required
          />
        </div>

        <div className="aiq-form-group">
          <label className="aiq-label" htmlFor="q-content">Content (JSON) *</label>
          <textarea
            id="q-content"
            className="aiq-input"
            style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", minHeight: 180, resize: "vertical" }}
            value={contentJson}
            onChange={(e) => { setContentJson(e.target.value); setJsonError(null); }}
            spellCheck={false}
          />
          {jsonError && (
            <div style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-xs)", marginTop: "var(--aiq-space-xs)" }}>
              {jsonError}
            </div>
          )}
        </div>

        <div>
          <button type="submit" className="aiq-btn aiq-btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create question"}
          </button>
        </div>
      </form>
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
// Edit page — shown when id is a real UUID
// ---------------------------------------------------------------------------

export function AdminQuestionEditor(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  // Route: /admin/question-bank/questions/new?pack_id=...&level_id=...
  if (id === "new") {
    const packId = searchParams.get("pack_id") ?? "";
    const levelId = searchParams.get("level_id") ?? "";
    return <CreateQuestionForm packId={packId} levelId={levelId} />;
  }

  return <AdminQuestionEditorInner id={id ?? ""} />;
}

function AdminQuestionEditorInner({ id }: { id: string }): React.ReactElement {
  const navigate = useNavigate();
  const [question, setQuestion] = useState<QuestionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Approve / archive state
  const [transitioning, setTransitioning] = useState(false);

  async function handleStatusTransition(status: "active" | "archived") {
    if (!id) return;
    if (status === "archived") {
      if (!window.confirm("Archive this question? It will no longer be available to candidates.")) return;
    }
    setTransitioning(true);
    setError(null);
    try {
      await adminApi(`/admin/questions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      void load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Status update failed.");
    } finally {
      setTransitioning(false);
    }
  }

  // Rubric generation state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [rubricDraft, setRubricDraft] = useState<RubricDraft | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [reasoningWeight, setReasoningWeight] = useState(50);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<QuestionDetail>(`/admin/questions/${id}`);
      setQuestion(data);
      if (data.rubric) {
        setRubricDraft(rubricToRubricDraft(data.rubric));
        const r = data.rubric as Record<string, unknown>;
        if (typeof r.reasoning_weight_total === "number") {
          setReasoningWeight(r.reasoning_weight_total);
        }
      }
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load question.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function handleGenerate() {
    if (!id) return;
    setGenerating(true);
    setGenerateError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await adminApi<RubricProposal>(`/admin/questions/${id}/generate-rubric`, {
        method: "POST",
        signal: controller.signal,
      });
      setRubricDraft(rubricToRubricDraft(result.proposal));
      const p = result.proposal as Record<string, unknown>;
      if (typeof p.reasoning_weight_total === "number") {
        setReasoningWeight(p.reasoning_weight_total);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setGenerateError("Generation cancelled.");
      } else {
        setGenerateError(err instanceof AdminApiError ? err.apiError.message : "Generation failed.");
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
  }

  async function handleSaveRubric(draft: RubricDraft) {
    if (!id) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await adminApi(`/admin/questions/${id}/save-rubric`, {
        method: "POST",
        body: JSON.stringify({ rubric: draftToRubric(draft, reasoningWeight) }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      // Reload to reflect saved state
      void load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    if (!window.confirm("Discard current rubric and re-generate? This will not save automatically.")) return;
    setRubricDraft(null);
    void handleGenerate();
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Editor"]} helpPage="admin.question.editor">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading question" />
        </div>
      </AdminShell>
    );
  }

  if (error && !question) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Editor"]} helpPage="admin.question.editor">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  if (!question) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Editor"]} helpPage="admin.question.editor">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>Not found.</div>
      </AdminShell>
    );
  }

  const supportsRubric =
    question.type === "subjective" ||
    question.type === "scenario" ||
    question.type === "log_analysis";

  // Live anchor weight total for the badge
  const anchorWeightTotal = rubricDraft
    ? Math.round(rubricDraft.anchors.reduce((s, a) => s + a.weight * 100, 0))
    : 0;
  const combinedTotal = anchorWeightTotal + reasoningWeight;
  const weightOk = combinedTotal === 100;

  return (
    <AdminShell breadcrumbs={["Question Bank", question.id.slice(0, 8)]} helpPage="admin.question.editor">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header row: title + status badge + back button */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--aiq-space-md)" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-xs)" }}>
              <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
                Edit rubric.</h1>
              <span
                style={{
                  padding: "1px 8px",
                  borderRadius: 4,
                  fontSize: "var(--aiq-text-xs)",
                  fontFamily: "var(--aiq-font-mono)",
                  background:
                    question.status === "active" ? "var(--aiq-color-success-bg, #d1fae5)" :
                    question.status === "ai_draft" ? "var(--aiq-color-warning-bg, #fef3c7)" :
                    question.status === "archived" ? "var(--aiq-color-bg-secondary, #f0f0f0)" :
                    "var(--aiq-color-bg-secondary, #f0f0f0)",
                  color:
                    question.status === "active" ? "var(--aiq-color-success, #065f46)" :
                    question.status === "ai_draft" ? "var(--aiq-color-warning, #92400e)" :
                    "var(--aiq-color-fg-muted)",
                  flexShrink: 0,
                }}
              >
                {question.status}
              </span>
            </div>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
              {[question.assessment_name, question.level_label, question.type, `${question.points} pts`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            onClick={() => navigate(-1)}
            style={{ flexShrink: 0 }}
          >
            ← Back to pack
          </button>
        </div>

        {saved && (
          <div style={{ color: "var(--aiq-color-success)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            Rubric saved.
          </div>
        )}
        {error && (
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {error}
          </div>
        )}

        {/* Question content preview */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
          <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: "var(--aiq-space-sm)" }}>
            Question content (read-only)
          </div>
          <QuestionContentView type={question.type} content={question.content} />
        </div>

        {/* Approve / archive — visible only for ai_draft */}
        {question.status === "ai_draft" && (
          <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
              Review actions
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
              <button
                className="aiq-btn aiq-btn-primary"
                disabled={transitioning}
                onClick={() => void handleStatusTransition("active")}
              >
                {transitioning ? "Saving…" : "Approve to active"}
              </button>
              <button
                className="aiq-btn aiq-btn-ghost"
                disabled={transitioning}
                onClick={() => void handleStatusTransition("archived")}
                style={{ color: "var(--aiq-color-danger)" }}
              >
                Reject (archive)
              </button>
            </div>
          </div>
        )}

        {/* Archive — for active/draft questions that are not yet archived */}
        {question.status !== "ai_draft" && question.status !== "archived" && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-ghost"
              disabled={transitioning}
              onClick={() => void handleStatusTransition("archived")}
              style={{ color: "var(--aiq-color-danger)" }}
            >
              {transitioning ? "Saving…" : "Archive question"}
            </button>
          </div>
        )}

        {/* Rubric section */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
          <h2
            {...(question.type === "subjective" ? { "data-help-id": "admin.questions.type.subjective.rubric" } : {})}
            style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-lg)" }}
          >
            Rubric
          </h2>

          {/* State A: no rubric yet */}
          {supportsRubric && !rubricDraft && !showManual && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
              {!generating && (
                <>
                  <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", color: "var(--aiq-color-fg-muted)" }}>
                    No rubric yet.
                  </p>
                  {question.type === "log_analysis" && (
                    <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
                      log_analysis questions auto-synthesize a rubric at grade time from expected_findings.
                      Generate a draft here and click <strong>Save rubric</strong> only if you want to override the auto-synth with a curated anchor list.
                    </p>
                  )}
                  <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
                    <button
                      className="aiq-btn aiq-btn-primary"
                      onClick={() => void handleGenerate()}
                      disabled={generating}
                    >
                      Auto-generate from level
                    </button>
                    <button
                      className="aiq-btn aiq-btn-ghost"
                      onClick={() => setShowManual(true)}
                      style={{ fontSize: "var(--aiq-text-sm)" }}
                    >
                      or fill manually below
                    </button>
                  </div>
                </>
              )}
              {generating && (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
                  <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
                    Generating rubric…
                  </div>
                  <RubricSkeleton />
                  <button className="aiq-btn aiq-btn-ghost" onClick={handleAbort} style={{ width: "fit-content" }}>
                    Abort
                  </button>
                </div>
              )}
              {generateError && (
                <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
                  {generateError}
                </div>
              )}
            </div>
          )}

          {/* State A manual fallback: show editor with empty draft */}
          {supportsRubric && !rubricDraft && showManual && (
            <RubricEditor
              initialDraft={{ anchors: [], bands: [] }}
              onSave={(draft) => void handleSaveRubric(draft)}
              submitting={saving}
            />
          )}

          {/* State B: rubric loaded (from DB or generated) */}
          {rubricDraft && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
              {/* Weight badge */}
              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: weightOk ? "var(--aiq-color-success-bg, #d1fae5)" : "var(--aiq-color-warning-bg, #fef3c7)",
                    color: weightOk ? "var(--aiq-color-success, #065f46)" : "var(--aiq-color-warning, #92400e)",
                  }}
                >
                  Anchor {anchorWeightTotal} + Reasoning {reasoningWeight} = {combinedTotal}/100
                  {!weightOk && " ⚠ must equal 100"}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                  <label htmlFor="reasoning-weight">Reasoning weight:</label>
                  <input
                    id="reasoning-weight"
                    type="number"
                    min={0}
                    max={100}
                    value={reasoningWeight}
                    onChange={(e) => setReasoningWeight(parseInt(e.target.value, 10) || 0)}
                    style={{ width: 56, padding: "2px 4px", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}
                  />
                </div>
              </div>

              <RubricEditor
                key={JSON.stringify(rubricDraft.anchors.map((a) => a.anchor_id))}
                initialDraft={rubricDraft}
                onSave={(draft) => {
                  setRubricDraft(draft);
                  void handleSaveRubric(draft);
                }}
                submitting={saving}
              />

              {supportsRubric && (
                <div>
                  <button
                    className="aiq-btn aiq-btn-ghost"
                    onClick={() => void handleRegenerate()}
                    disabled={generating || saving}
                    style={{ fontSize: "var(--aiq-text-sm)" }}
                  >
                    Re-generate
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Non-rubric question types */}
          {!supportsRubric && (
            <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", color: "var(--aiq-color-fg-muted)" }}>
              Rubric not applicable for question type &ldquo;{question.type}&rdquo;.
            </p>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
