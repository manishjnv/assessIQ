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

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell.js";
import { RubricEditor } from "../components/RubricEditor.js";
import type { RubricDraft } from "../components/RubricEditor.js";
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
  points: number;
  content: unknown;
  rubric: unknown;
  assessment_name?: string;
  level_label?: string;
}

function parseRubric(raw: unknown): RubricDraft {
  if (!raw || typeof raw !== "object") return { anchors: [], bands: [] };
  const r = raw as Record<string, unknown>;
  return {
    anchors: Array.isArray(r.anchors) ? r.anchors : [],
    bands: Array.isArray(r.bands) ? r.bands : [],
  };
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
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-2xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.015em" }}>
          New question
        </h1>

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
  const [question, setQuestion] = useState<QuestionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<QuestionDetail>(`/admin/questions/${id}`);
      setQuestion(data);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load question.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function handleSaveRubric(draft: RubricDraft) {
    if (!id) return;
    setSaving(true);
    setSaved(false);
    try {
      await adminApi(`/admin/questions/${id}/rubric`, {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Editor"]} helpPage="admin.question.editor">
        <div style={{ padding: "var(--aiq-space-3xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>Loading…</div>
      </AdminShell>
    );
  }

  if (error || !question) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Editor"]} helpPage="admin.question.editor">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const contentText = typeof question.content === "string" ? question.content : JSON.stringify(question.content, null, 2);

  return (
    <AdminShell breadcrumbs={["Question Bank", question.id.slice(0, 8)]} helpPage="admin.question.editor">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-2xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.015em" }}>
            Edit rubric
          </h1>
          {question.assessment_name && (
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginTop: "var(--aiq-space-xs)" }}>
              {question.assessment_name} · {question.level_label} · {question.type} · {question.points} pts
            </div>
          )}
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
          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-primary)" }}>
            {contentText}
          </p>
        </div>

        {/* Rubric editor */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
          <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-lg)" }}>
            Rubric
          </h2>
          <RubricEditor
            initialDraft={parseRubric(question.rubric)}
            onSave={(draft) => void handleSaveRubric(draft)}
            submitting={saving}
          />
        </div>
      </div>
    </AdminShell>
  );
}
