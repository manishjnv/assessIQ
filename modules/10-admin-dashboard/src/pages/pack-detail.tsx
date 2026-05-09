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

type GenerationAttemptStatus = "success" | "partial" | "failed" | "running";

interface GenerationAttempt {
  id: string;
  status: GenerationAttemptStatus;
  count_requested: number;
  count_inserted: number;
  error_code: string | null;
  error_message: string | null;
  stderr_tail: string | null;
  model: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

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
  topic?: string | null;
  points?: number;
  created_at?: string;
  content: Record<string, unknown>;
  knowledge_base_sources?: Array<{ id: string; name: string; citation: string; url?: string }>;
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

/** All SOC function categories present in the knowledge base. */
const SOC_FUNCTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "triage",       label: "Triage"       },
  { value: "detection",    label: "Detection"    },
  { value: "analysis",     label: "Analysis"     },
  { value: "response",     label: "Response"     },
  { value: "forensics",    label: "Forensics"    },
  { value: "hunting",      label: "Threat Hunt"  },
  { value: "intelligence", label: "Intelligence" },
  { value: "governance",   label: "Governance"   },
  { value: "architecture", label: "Architecture" },
];

function questionPrompt(content: Record<string, unknown>): string {
  const c = content as { prompt?: string; stem?: string; scenario?: string; question?: string; title?: string };
  return c.prompt ?? c.stem ?? c.scenario ?? c.question ?? c.title ?? "—";
}

/** Format a date string as relative (< 30 days) or absolute (≥ 30 days). */
function relativeDate(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 30) {
    return new Date(isoStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return "just now";
}

/** Format a date string as relative (< 30 min) or absolute (≥ 30 min). */
function attemptDate(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 30) {
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
    if (minutes < 1) return "just now";
    return rtf.format(-minutes, "minute");
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoStr));
}

/** Format milliseconds as "Xm Ys" for display. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Renders the last-attempt status line shown below the level header. */
function GenerationAttemptLine({
  attempt,
  detailsOpen,
  onToggleDetails,
}: {
  attempt: GenerationAttempt | null | undefined;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}): React.ReactElement | null {
  if (!attempt) return null;

  const { status, count_requested, count_inserted, error_code, error_message,
          stderr_tail, duration_ms, started_at, chunks_failed } = attempt as GenerationAttempt & { chunks_failed?: number | null };

  const dateStr = attemptDate(started_at);
  const durStr = duration_ms != null ? formatDuration(duration_ms) : null;

  if (status === "running") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-accent)", marginLeft: "var(--aiq-space-sm)" }}>
        ⟳ Generation in progress…
      </span>
    );
  }

  if (status === "success") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-success)", marginLeft: "var(--aiq-space-sm)" }}>
        ✓ Last generation: {count_inserted} question{count_inserted !== 1 ? "s" : ""}
        {durStr ? ` in ${durStr}` : ""} ({dateStr})
      </span>
    );
  }

  if (status === "partial") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-warning, #d97706)", marginLeft: "var(--aiq-space-sm)" }}>
        ⚠ Last generation: {count_inserted} of {count_requested}
        {chunks_failed ? ` (${chunks_failed} chunk${chunks_failed !== 1 ? "s" : ""} failed)` : ""}
        {durStr ? ` in ${durStr}` : ""} ({dateStr})
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-danger)", marginLeft: "var(--aiq-space-sm)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
        ✗ Last generation failed{error_code ? `: ${error_code}` : ""}
        {(error_message || stderr_tail) && (
          <>
            {" "}
            <button
              type="button"
              onClick={onToggleDetails}
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-danger)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              {detailsOpen ? "Hide" : "Details"}
            </button>
            {detailsOpen && (
              <pre
                style={{
                  display: "block",
                  marginTop: "var(--aiq-space-xs)",
                  padding: "var(--aiq-space-sm)",
                  background: "var(--aiq-color-bg-sunken)",
                  borderRadius: "var(--aiq-radius-sm)",
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "10px",
                  color: "var(--aiq-color-fg-secondary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: "160px",
                  overflowY: "auto",
                  width: "100%",
                }}
              >
                {[error_message, stderr_tail].filter(Boolean).join("\n---\n")}
              </pre>
            )}
          </>
        )}
      </span>
    );
  }

  return null;
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

  // Archive pack state
  const [archivingPack, setArchivingPack] = useState(false);
  const [archivePackError, setArchivePackError] = useState<string | null>(null);

  // Archive question state (tracks which question id is being archived)
  const [archivingQuestion, setArchivingQuestion] = useState<string | null>(null);

  // Client-side filter state (applies to all level question lists)
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");

  // Generate-questions drawer state
  const [generateLevelId, setGenerateLevelId] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(5);
  const [genTopicFocus, setGenTopicFocus] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ generated: number; skillSha: string } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Per-level last generation attempt (keyed by levelId)
  const [lastAttempts, setLastAttempts] = useState<Record<string, GenerationAttempt | null>>({});
  // Tracks which level's Details disclosure is open
  const [openAttemptDetails, setOpenAttemptDetails] = useState<string | null>(null);

  const fetchPack = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setQuestionsError(null);
    let fetchedLevels: Level[] = [];
    try {
      const detail = await adminApi<PackDetailResponse>(`/admin/packs/${id}`);
      setPack(detail.pack);
      fetchedLevels = detail.levels.slice().sort((a, b) => a.order - b.order);
      setLevels(fetchedLevels);
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
    // Fetch last generation attempt for each level (best-effort; errors silently ignored)
    const attempts: Record<string, GenerationAttempt | null> = {};
    await Promise.allSettled(
      fetchedLevels.map(async (level) => {
        try {
          const rows = await adminApi<GenerationAttempt[]>(
            `/admin/packs/${id}/levels/${level.id}/generation-attempts`,
          );
          attempts[level.id] = rows.length > 0 ? rows[0]! : null;
        } catch {
          attempts[level.id] = null;
        }
      }),
    );
    setLastAttempts(attempts);
  }, [id]);

  /** Refresh attempts for a single level after a generate completes or fails. */
  const refreshAttempt = useCallback(async (packId: string, levelId: string) => {
    try {
      const rows = await adminApi<GenerationAttempt[]>(
        `/admin/packs/${packId}/levels/${levelId}/generation-attempts`,
      );
      setLastAttempts((prev) => ({ ...prev, [levelId]: rows.length > 0 ? rows[0]! : null }));
    } catch {
      // Non-critical: ignore
    }
  }, []);

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

  async function handleArchivePack() {
    if (!id || !pack) return;
    if (!window.confirm(`Are you sure? This will archive "${pack.name}".`)) return;
    setArchivingPack(true);
    setArchivePackError(null);
    try {
      await adminApi(`/admin/packs/${id}/archive`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      setArchivePackError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to archive pack.",
      );
    } finally {
      setArchivingPack(false);
    }
  }

  async function handleArchiveQuestion(questionId: string, topic: string) {
    if (!window.confirm(`Are you sure? This will archive "${topic || questionId.slice(0, 8)}".`)) return;
    setArchivingQuestion(questionId);
    try {
      await adminApi(`/admin/questions/${questionId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      });
      await fetchPack();
    } catch (err) {
      console.warn("archive-question error:", err instanceof AdminApiError ? err.apiError.message : err);
    } finally {
      setArchivingQuestion(null);
    }
  }

  async function handleGenerate(levelId: string) {
    if (!id) return;
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      const body: Record<string, unknown> = { count: genCount };
      if (genTopicFocus) body["topic_focus"] = genTopicFocus;
      const result = await adminApi<{ questionIds: string[]; generated: number; skillSha: string }>(
        `/admin/packs/${id}/levels/${levelId}/generate`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setGenResult({ generated: result.generated, skillSha: result.skillSha });
      // Refresh question list so drafts appear immediately
      await fetchPack();
    } catch (err) {
      setGenError(
        err instanceof AdminApiError ? err.apiError.message : "Generation failed. Try again.",
      );
    } finally {
      setGenerating(false);
      // Always refresh attempt status after generate, success or failure
      void refreshAttempt(id, levelId);
    }
  }

  function openGenerateDrawer(levelId: string) {
    setGenerateLevelId(levelId);
    setGenCount(5);
    setGenTopicFocus(null);
    setGenResult(null);
    setGenError(null);
  }

  function closeGenerateDrawer() {
    if (generating) return; // block close while in-flight
    setGenerateLevelId(null);
    setGenResult(null);
    setGenError(null);
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
            {pack.status !== "archived" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                onClick={() => void handleArchivePack()}
                disabled={archivingPack}
                style={{ color: "var(--aiq-color-danger)" }}
              >
                {archivingPack ? "Archiving…" : "Archive pack"}
              </button>
            )}
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

        {archivePackError && (
          <div
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {archivePackError}
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
                        borderBottom: "1px solid var(--aiq-color-border)",
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
                        <GenerationAttemptLine
                          attempt={lastAttempts[level.id]}
                          detailsOpen={openAttemptDetails === level.id}
                          onToggleDetails={() =>
                            setOpenAttemptDetails((prev) =>
                              prev === level.id ? null : level.id,
                            )
                          }
                        />
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
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-outline aiq-btn-sm"
                          onClick={() => openGenerateDrawer(level.id)}
                          title="Generate AI draft questions for this level"
                        >
                          ✦ Generate
                        </button>
                        <Link
                          to={`/admin/question-bank/questions/new?pack_id=${pack.id}&level_id=${level.id}`}
                          className="aiq-btn aiq-btn-outline aiq-btn-sm"
                          style={{ textDecoration: "none" }}
                        >
                          + Add question
                        </Link>
                      </div>
                    </div>

                    {/* Filter chips — only when level has questions */}
                    {levelQs.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: "4px",
                          padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                          borderBottom: "1px solid var(--aiq-color-border)",
                          background: "var(--aiq-color-bg-raised)",
                        }}
                      >
                        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 2 }}>Status:</span>
                        {(["", "ai_draft", "draft", "active", "archived"] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={`aiq-btn aiq-btn-sm ${filterStatus === s ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                            onClick={() => setFilterStatus(s)}
                          >
                            {s || "all"}
                          </button>
                        ))}
                        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginLeft: 8, marginRight: 2 }}>Type:</span>
                        {(["", "mcq", "log_analysis", "scenario", "kql", "subjective"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`aiq-btn aiq-btn-sm ${filterType === t ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                            onClick={() => setFilterType(t)}
                          >
                            {t || "all"}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Questions list */}
                    {(() => {
                      const filteredQs = levelQs.filter(
                        (q) =>
                          (filterStatus === "" || q.status === filterStatus) &&
                          (filterType === "" || q.type === filterType),
                      );
                      if (levelQs.length === 0) {
                        return (
                          <div
                            style={{
                              padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                              color: "var(--aiq-color-fg-muted)",
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                            }}
                          >
                            No questions yet. Click ✦ Generate or + Add question to start.
                          </div>
                        );
                      }
                      if (filteredQs.length === 0) {
                        return (
                          <div
                            style={{
                              padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                              color: "var(--aiq-color-fg-muted)",
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                            }}
                          >
                            No questions match the current filter.
                          </div>
                        );
                      }
                      return filteredQs.map((q, qi) => (
                        <div
                          key={q.id}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                            borderBottom:
                              qi < filteredQs.length - 1
                                ? "1px solid var(--aiq-color-border)"
                                : "none",
                            background: "var(--aiq-color-bg-base)",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Primary line: topic (or prompt fallback) */}
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
                              {q.topic && q.topic.trim() ? q.topic : questionPrompt(q.content)}
                            </span>
                            {/* Secondary line: type · status · points · date */}
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
                              {q.points != null ? ` · ${q.points} pts` : ""}
                              {q.created_at ? ` · ${relativeDate(q.created_at)}` : ""}
                            </span>
                            {/* Citation chips */}
                            {q.knowledge_base_sources && q.knowledge_base_sources.length > 0 && (
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: "4px",
                                  marginTop: "4px",
                                }}
                              >
                                {q.knowledge_base_sources.map((src) => (
                                  <a
                                    key={src.id}
                                    href={src.url ?? "#"}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={src.name}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "3px",
                                      fontFamily: "var(--aiq-font-mono)",
                                      fontSize: "10px",
                                      lineHeight: 1,
                                      padding: "2px 6px",
                                      borderRadius: "var(--aiq-radius-pill)",
                                      background: "var(--aiq-color-accent-soft)",
                                      color: "var(--aiq-color-accent)",
                                      textDecoration: "none",
                                      letterSpacing: "0.02em",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {src.citation}
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: "var(--aiq-space-xs)",
                              flexShrink: 0,
                              marginLeft: "var(--aiq-space-md)",
                              alignItems: "center",
                            }}
                          >
                            {q.status !== "archived" && (
                              <button
                                type="button"
                                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                                disabled={archivingQuestion === q.id}
                                onClick={() =>
                                  void handleArchiveQuestion(
                                    q.id,
                                    q.topic ?? questionPrompt(q.content),
                                  )
                                }
                                style={{ color: "var(--aiq-color-danger)" }}
                              >
                                {archivingQuestion === q.id ? "…" : "Archive"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                              onClick={() =>
                                navigate(`/admin/question-bank/questions/${q.id}`)
                              }
                            >
                              Edit
                            </button>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Generate Questions Drawer */}
      {generateLevelId !== null && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeGenerateDrawer}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              zIndex: 100,
            }}
          />
          {/* Drawer panel */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Generate AI draft questions"
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(480px, 100vw)",
              background: "var(--aiq-color-bg-base)",
              borderLeft: "1px solid var(--aiq-color-border)",
              zIndex: 101,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Drawer header */}
            <div
              style={{
                padding: "var(--aiq-space-lg)",
                borderBottom: "1px solid var(--aiq-color-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexShrink: 0,
              }}
            >
              <div>
                <h3
                  style={{
                    fontFamily: "var(--aiq-font-serif)",
                    fontSize: "var(--aiq-text-xl)",
                    fontWeight: 400,
                    margin: 0,
                    letterSpacing: "-0.015em",
                  }}
                >
                  Generate questions.
                </h3>
                <p
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    margin: "4px 0 0",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {levels.find((l) => l.id === generateLevelId)?.label ?? "Level"} · SOC grounded · ai_draft
                </p>
              </div>
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                onClick={closeGenerateDrawer}
                disabled={generating}
                aria-label="Close drawer"
              >
                ✕
              </button>
            </div>

            {/* Drawer body */}
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: "var(--aiq-space-lg)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--aiq-space-lg)",
              }}
            >
              {/* Count */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                <label
                  htmlFor="gen-count"
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    fontWeight: 500,
                  }}
                >
                  Number of questions
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                  <input
                    id="gen-count"
                    type="range"
                    min={1}
                    max={30}
                    value={genCount}
                    onChange={(e) => setGenCount(Number(e.target.value))}
                    disabled={generating}
                    style={{ flex: 1, accentColor: "var(--aiq-color-accent)" }}
                  />
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-sm)",
                      minWidth: "2ch",
                      textAlign: "right",
                    }}
                  >
                    {genCount}
                  </span>
                </div>
                <p
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    margin: 0,
                  }}
                >
                  Generation takes 30–90 seconds per question.
                </p>
                {genCount > 10 && (
                  <p
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      color: "var(--aiq-color-fg-muted)",
                      margin: 0,
                    }}
                  >
                    {genCount <= 20
                      ? "Splits into 2 parallel calls (~3–4 min)."
                      : "Splits into 3 parallel calls (~3–5 min)."}
                  </p>
                )}
                <p
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    margin: 0,
                  }}
                >
                  Tip: to build a larger bank, click Generate again within 5 minutes of the previous run. Cached context cuts the next call to ~30–60s.
                </p>
              </div>

              {/* Topic focus chips */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    fontWeight: 500,
                  }}
                >
                  Topic focus{" "}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      fontWeight: 400,
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    (optional — select one)
                  </span>
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {SOC_FUNCTIONS.map((fn) => {
                    const active = genTopicFocus === fn.value;
                    return (
                      <button
                        key={fn.value}
                        type="button"
                        disabled={generating}
                        onClick={() =>
                          setGenTopicFocus((prev) => (prev === fn.value ? null : fn.value))
                        }
                        style={{
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          padding: "4px 10px",
                          borderRadius: "var(--aiq-radius-pill)",
                          border: `1px solid ${active ? "var(--aiq-color-accent)" : "var(--aiq-color-border)"}`,
                          background: active ? "var(--aiq-color-accent-soft)" : "transparent",
                          color: active ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)",
                          cursor: generating ? "not-allowed" : "pointer",
                          letterSpacing: "0.02em",
                        }}
                      >
                        {fn.label}
                      </button>
                    );
                  })}
                </div>
                <p
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    margin: 0,
                  }}
                >
                  Narrows KB sources to the selected function. Falls back to full level if fewer than 3 sources match.
                </p>
              </div>

              {/* Error */}
              {genError && (
                <div
                  style={{
                    padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                    borderRadius: "var(--aiq-radius-md)",
                    background: "var(--aiq-color-danger-soft, rgba(220,38,38,0.06))",
                    border: "1px solid var(--aiq-color-danger-border, var(--aiq-color-danger))",
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    color: "var(--aiq-color-danger)",
                  }}
                >
                  {genError}
                </div>
              )}

              {/* Success */}
              {genResult && (
                <div
                  style={{
                    padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                    borderRadius: "var(--aiq-radius-md)",
                    background: "var(--aiq-color-success-soft)",
                    border: "1px solid var(--aiq-color-success-border, var(--aiq-color-success))",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                      color: "var(--aiq-color-success)",
                    }}
                  >
                    {genResult.generated} draft question{genResult.generated !== 1 ? "s" : ""} generated.
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    skill sha: {genResult.skillSha}
                  </span>
                </div>
              )}

              {/* In-flight progress */}
              {generating && (
                <div
                  style={{
                    padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                    borderRadius: "var(--aiq-radius-md)",
                    background: "var(--aiq-color-accent-soft)",
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-accent)",
                  }}
                >
                  Generating… this typically takes 30–90 s per question. Do not close this panel.
                </div>
              )}
            </div>

            {/* Drawer footer */}
            <div
              style={{
                padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                borderTop: "1px solid var(--aiq-color-border)",
                display: "flex",
                justifyContent: "flex-end",
                gap: "var(--aiq-space-sm)",
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
                onClick={closeGenerateDrawer}
                disabled={generating}
              >
                {genResult ? "Close" : "Cancel"}
              </button>
              {!genResult && (
                <button
                  type="button"
                  className="aiq-btn aiq-btn-primary"
                  onClick={() => void handleGenerate(generateLevelId)}
                  disabled={generating}
                >
                  {generating ? "Generating…" : `Generate ${genCount} draft${genCount !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </AdminShell>
  );
}
