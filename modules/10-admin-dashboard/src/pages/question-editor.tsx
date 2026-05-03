// AssessIQ — Admin question editor page.
//
// /admin/question-bank/questions/:id
//
// Inline RubricEditor + question content viewer.
// Consumes: GET /api/admin/questions/:id + PATCH /api/admin/questions/:id/rubric
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - Question content shown as plain text only.
//  - Rubric changes never auto-save — explicit "Save rubric" button only.

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { AdminShell } from "../components/AdminShell.js";
import { RubricEditor } from "../components/RubricEditor.js";
import type { RubricDraft } from "../components/RubricEditor.js";
import { adminApi, AdminApiError } from "../api.js";

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

export function AdminQuestionEditor(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
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
