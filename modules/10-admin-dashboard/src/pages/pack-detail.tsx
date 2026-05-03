// AssessIQ — Admin Pack Detail page.
//
// /admin/question-bank/:id
//
// Shows: pack header (name, version, status), levels with per-level question
// lists, "+ Add level" inline form, "+ Add question" link per level,
// "Activate all" per level (published packs only), "Publish" CTA for drafts.
//
// Fetches:
//   GET /admin/packs/:id             → { pack, levels }
//   GET /admin/questions?pack_id=:id → paginated questions (grouped client-side)
//   POST /admin/packs/:id/levels     → add level
//   POST /admin/packs/:id/publish    → draft → published
//   POST /admin/packs/:id/activate-questions → bulk-activate draft questions
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

type PackStatus = "draft" | "published" | "archived";

interface Level {
  id: string;
  label: string;
  description: string | null;
  order: number;
}

interface Pack {
  id: string;
  name: string;
  domain: string;
  status: PackStatus;
  version: number;
  created_at: string;
  description: string | null;
}

interface QuestionItem {
  id: string;
  level_id: string;
  type: string;
  status: string;
  content: Record<string, unknown>;
}

interface PackDetailResponse {
  pack: Pack;
  levels: Level[];
}

interface QuestionsResponse {
  items: QuestionItem[];
  total: number;
}

function packStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "published":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "archived":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
  }
}

function questionPrompt(content: Record<string, unknown>): string {
  const c = content as { prompt?: string; stem?: string; scenario?: string };
  return c.prompt ?? c.stem ?? c.scenario ?? "—";
}

export function AdminPackDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pack, setPack] = useState<Pack | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [questionsError, setQuestionsError] = useState<string | null>(null);

  const [showAddLevel, setShowAddLevel] = useState(false);
  const [levelLabel, setLevelLabel] = useState("");
  const [addingLevel, setAddingLevel] = useState(false);
  const [addLevelError, setAddLevelError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [activatingLevel, setActivatingLevel] = useState<string | null>(null);

  const fetchPack = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setQuestionsError(null);
    try {
      const detail = await adminApi<PackDetailResponse>(`/admin/packs/${id}`);
      setPack(detail.pack);
      setLevels(detail.levels.slice().sort((a, b) => a.order - b.order));
    } catch (err) {
      setError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to load pack.",
      );
      setLoading(false);
      return;
    }
    try {
      const qData = await adminApi<QuestionsResponse>(`/admin/questions?pack_id=${id}&pageSize=500`);
      setQuestions(qData.items);
    } catch (err) {
      setQuestionsError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to load questions.",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchPack();
  }, [fetchPack]);

  async function handleAddLevel(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !levelLabel.trim()) {
      setAddLevelError("Level label is required.");
      return;
    }
    setAddingLevel(true);
    setAddLevelError(null);
    try {
      await adminApi(`/admin/packs/${id}/levels`, {
        method: "POST",
        body: JSON.stringify({ label: levelLabel.trim() }),
      });
      setLevelLabel("");
      setShowAddLevel(false);
      await fetchPack();
    } catch (err) {
      setAddLevelError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to add level.",
      );
    } finally {
      setAddingLevel(false);
    }
  }

  async function handlePublish() {
    if (!id) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await adminApi(`/admin/packs/${id}/publish`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      setPublishError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to publish pack.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function handleActivateAll(levelId: string) {
    if (!id) return;
    setActivatingLevel(levelId);
    try {
      await adminApi(`/admin/packs/${id}/activate-questions`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      // Surface as a console warning — this is a convenience affordance,
      // not blocking. The pack is still usable without activating all.
      console.warn("activate-questions error:", err instanceof AdminApiError ? err.apiError.message : err);
    } finally {
      setActivatingLevel(null);
    }
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Pack"]} helpPage="admin.question_bank.pack">
        <div
          style={{
            color: "var(--aiq-color-fg-muted)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            padding: "var(--aiq-space-xl) 0",
          }}
        >
          Loading…
        </div>
      </AdminShell>
    );
  }

  if (error || !pack) {
    return (
      <AdminShell breadcrumbs={["Question Bank", "Pack"]} helpPage="admin.question_bank.pack">
        <div
          style={{
            color: "var(--aiq-color-danger)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {error ?? "Pack not found."}
        </div>
      </AdminShell>
    );
  }

  const sc = packStatusColor(pack.status);

  const questionsByLevel = questions.reduce<Record<string, QuestionItem[]>>((acc, q) => {
    const arr = acc[q.level_id];
    if (arr) arr.push(q);
    else acc[q.level_id] = [q];
    return acc;
  }, {});

  return (
    <AdminShell breadcrumbs={["Question Bank", pack.name]} helpPage="admin.question_bank.pack">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Pack header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--aiq-space-md)",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--aiq-space-sm)",
                marginBottom: "var(--aiq-space-xs)",
              }}
            >
              <h1
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-3xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.02em",
                }}
              >
                {pack.name}.
              </h1>
              <span
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "1px 8px",
                  borderRadius: "var(--aiq-radius-pill)",
                  background: sc.bg,
                  color: sc.color,
                  flexShrink: 0,
                }}
              >
                {pack.status}
              </span>
            </div>
            <p
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {pack.domain} · v{pack.version} · created{" "}
              {new Date(pack.created_at).toLocaleDateString()}
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexShrink: 0 }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={() => navigate("/admin/question-bank")}
            >
              ← Back
            </button>
            {pack.status === "draft" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary"
                onClick={() => void handlePublish()}
                disabled={publishing}
              >
                {publishing ? "Publishing…" : "Publish pack"}
              </button>
            )}
          </div>
        </div>

        {publishError && (
          <div
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {publishError}
          </div>
        )}

        {questionsError && (
          <div
            style={{
              border: "1px solid var(--aiq-color-danger-border, var(--aiq-color-danger))",
              borderRadius: "var(--aiq-radius-md)",
              padding: "var(--aiq-space-md) var(--aiq-space-lg)",
              background: "var(--aiq-color-danger-soft, rgba(220,38,38,0.06))",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--aiq-space-md)",
            }}
          >
            <div>
              <p
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  fontWeight: 500,
                  color: "var(--aiq-color-danger)",
                  margin: "0 0 2px 0",
                }}
              >
                Couldn&apos;t load questions.
              </p>
              <p
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  color: "var(--aiq-color-fg-muted)",
                  margin: 0,
                }}
              >
                {questionsError}
              </p>
            </div>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={() => void fetchPack()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Levels section */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Levels.
            </h2>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={() => {
                setShowAddLevel((v) => !v);
                setAddLevelError(null);
              }}
            >
              {showAddLevel ? "Cancel" : "+ Add level"}
            </button>
          </div>

          {/* Add-level inline form */}
          {showAddLevel && (
            <div
              style={{
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
                padding: "var(--aiq-space-md)",
                marginBottom: "var(--aiq-space-md)",
                background: "var(--aiq-color-bg-raised)",
              }}
            >
              <form
                onSubmit={(e) => void handleAddLevel(e)}
                style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "flex-end" }}
              >
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Level label *
                  </label>
                  <input
                    className="aiq-input"
                    type="text"
                    placeholder="e.g. L1 — Foundations"
                    value={levelLabel}
                    onChange={(e) => setLevelLabel(e.target.value)}
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="aiq-btn aiq-btn-primary"
                  disabled={addingLevel}
                >
                  {addingLevel ? "Adding…" : "Add level"}
                </button>
              </form>
              {addLevelError && (
                <div
                  style={{
                    color: "var(--aiq-color-danger)",
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    marginTop: "var(--aiq-space-xs)",
                  }}
                >
                  {addLevelError}
                </div>
              )}
            </div>
          )}

          {levels.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "var(--aiq-space-2xl) 0",
                color: "var(--aiq-color-fg-muted)",
                border: "1px dashed var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  margin: 0,
                }}
              >
                No levels yet. Add a level to start building this pack.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
              {levels.map((level) => {
                const levelQs = questionsByLevel[level.id] ?? [];
                return (
                  <div
                    key={level.id}
                    style={{
                      border: "1px solid var(--aiq-color-border)",
                      borderRadius: "var(--aiq-radius-md)",
                      overflow: "hidden",
                    }}
                  >
                    {/* Level header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                        background: "var(--aiq-color-bg-raised)",
                        borderBottom:
                          levelQs.length > 0 ? "1px solid var(--aiq-color-border)" : "none",
                      }}
                    >
                      <div>
                        <span
                          style={{
                            fontFamily: "var(--aiq-font-sans)",
                            fontWeight: 500,
                            fontSize: "var(--aiq-text-sm)",
                          }}
                        >
                          {level.label}
                        </span>
                        {level.description && (
                          <span
                            style={{
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                              color: "var(--aiq-color-fg-secondary)",
                              marginLeft: "var(--aiq-space-sm)",
                            }}
                          >
                            — {level.description}
                          </span>
                        )}
                      </div>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--aiq-font-mono)",
                            fontSize: "var(--aiq-text-xs)",
                            color: "var(--aiq-color-fg-muted)",
                          }}
                        >
                          {levelQs.length} question{levelQs.length !== 1 ? "s" : ""}
                        </span>
                        {pack.status === "published" && (
                          <button
                            type="button"
                            className="aiq-btn aiq-btn-outline aiq-btn-sm"
                            onClick={() => void handleActivateAll(level.id)}
                            disabled={activatingLevel === level.id}
                          >
                            {activatingLevel === level.id ? "Activating…" : "Activate all"}
                          </button>
                        )}
                        <Link
                          to={`/admin/question-bank/questions/new?pack_id=${pack.id}&level_id=${level.id}`}
                          className="aiq-btn aiq-btn-outline aiq-btn-sm"
                          style={{ textDecoration: "none" }}
                        >
                          + Add question
                        </Link>
                      </div>
                    </div>

                    {/* Questions list */}
                    {levelQs.map((q, qi) => (
                      <div
                        key={q.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                          borderBottom:
                            qi < levelQs.length - 1
                              ? "1px solid var(--aiq-color-border)"
                              : "none",
                          background: "var(--aiq-color-bg-base)",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                              display: "block",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              marginBottom: 2,
                            }}
                          >
                            {questionPrompt(q.content)}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--aiq-font-mono)",
                              fontSize: "var(--aiq-text-xs)",
                              color: "var(--aiq-color-fg-muted)",
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {q.type} · {q.status}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                          onClick={() => navigate(`/admin/question-bank/questions/${q.id}`)}
                          style={{ flexShrink: 0, marginLeft: "var(--aiq-space-md)" }}
                        >
                          Edit
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
