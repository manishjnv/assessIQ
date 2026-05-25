// AssessIQ — Admin Pack Detail page.
//
// /admin/question-bank/:id
//
// READ-ONLY CATALOG. Shows: pack header (name, version, status), levels with
// per-level question lists, "Activate all" per level (published packs only),
// "Publish" / "Archive pack" CTAs. Question creation lives on the dedicated
// Generate Questions page (/admin/generate-wizard).
//
// Fetches:
//   GET /admin/packs/:id             → { pack, levels }
//   GET /admin/questions?pack_id=:id → paginated questions (grouped client-side)
//   POST /admin/packs/:id/publish    → draft → published
//   POST /admin/packs/:id/activate-questions → bulk-activate draft questions
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chip } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, bulkUpdateQuestionStatus } from "../api.js";
import { useAdminSession } from "../session.js";

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

function questionPrompt(content: Record<string, unknown>): string {
  const c = content as { prompt?: string; stem?: string; scenario?: string; question?: string; title?: string };
  return c.prompt ?? c.stem ?? c.scenario ?? c.question ?? c.title ?? "";
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
  pollExhausted,
}: {
  attempt: GenerationAttempt | null | undefined;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  pollExhausted?: boolean;
}): React.ReactElement | null {
  if (!attempt) return null;

  const { status, count_requested, count_inserted, error_code, error_message,
          stderr_tail, duration_ms, started_at } = attempt;

  const dateStr = attemptDate(started_at);
  const durStr = duration_ms != null ? formatDuration(duration_ms) : null;
  const failedCount = count_requested - count_inserted;

  const detailsToggle = (color: string) =>
    (error_message || stderr_tail) ? (
      <>
        {" "}
        <button
          type="button"
          onClick={onToggleDetails}
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color,
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
    ) : null;

  if (status === "running") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-accent)" }}>
        {pollExhausted ? "⟳ Still running… refresh to check" : "⟳ Generation in progress…"}
      </span>
    );
  }

  if (status === "success") {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-success)" }}>
        ✓ Last generation: {count_inserted} question{count_inserted !== 1 ? "s" : ""}
        {durStr ? ` in ${durStr}` : ""} — {dateStr}
      </span>
    );
  }

  if (status === "partial") {
    const color = "var(--aiq-color-warning, #d97706)";
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color, display: "inline-flex", alignItems: "center", gap: "4px" }}>
        ⚠ Last generation: {count_inserted} of {count_requested}
        {failedCount > 0 ? ` (${failedCount} chunk${failedCount !== 1 ? "s" : ""} failed)` : ""}
        {durStr ? ` in ${durStr}` : ""} — {dateStr}
        {detailsToggle(color)}
      </span>
    );
  }

  if (status === "failed") {
    const color = "var(--aiq-color-danger)";
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color, display: "inline-flex", alignItems: "center", gap: "4px" }}>
        ✗ Last generation failed{error_code ? `: ${error_code}` : ""} — {dateStr}
        {detailsToggle(color)}
      </span>
    );
  }

  return null;
}

export function AdminPackDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Phase B1 entitlement model (2026-05-17/18): super_admin curates the
  // shared library; tenant admins receive entitlements to specific packs
  // but do not author/generate/curate content. Curation affordances
  // (Publish/Archive pack, Activate questions, the "✦ Generate questions →"
  // link to /admin/generate-wizard) are hidden for non-super_admin. Question
  // CREATION lives entirely on the Generate Questions page (create-vs-catalog
  // separation, Step 2 5c) — this page is now a read-only catalog.
  // See docs/04-auth-flows.md + obs #3180 / #3182 for the decision.
  const { session } = useAdminSession();
  const isSuperAdmin = session?.user.role === "super_admin";

  const [pack, setPack] = useState<Pack | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [questionsError, setQuestionsError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Revise (published → draft, "revise → publish new version") state
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);

  const [activatingLevel, setActivatingLevel] = useState<string | null>(null);

  // Archive pack state
  const [archivingPack, setArchivingPack] = useState(false);
  const [archivePackError, setArchivePackError] = useState<string | null>(null);

  // Archive question state (tracks which question id is being archived)
  const [archivingQuestion, setArchivingQuestion] = useState<string | null>(null);

  // Bulk multi-select state — keyed by levelId
  const [levelSelections, setLevelSelections] = useState<Record<string, Set<string>>>({});
  // Pending bulk confirm modal (non-null = modal open)
  const [bulkConfirm, setBulkConfirm] = useState<{
    levelId: string;
    action: "active" | "archived";
    ids: string[];
  } | null>(null);
  // Which level is currently executing a bulk request
  const [bulkingLevel, setBulkingLevel] = useState<string | null>(null);
  // Last bulk result for the success banner (cleared on fetchPack re-run)
  const [bulkResult, setBulkResult] = useState<{
    levelId: string;
    updated: number;
    ids: string[];
  } | null>(null);
  const [bulkResultDetailsOpen, setBulkResultDetailsOpen] = useState(false);

  // Per-level client-side filter state (keyed by levelId)
  const [levelFilters, setLevelFilters] = useState<Record<string, { status: string; type: string }>>({});
  // Per-level poll counts for "running" generation attempts (gives up after 10 polls / 50s)
  const [runningPollCounts, setRunningPollCounts] = useState<Record<string, number>>({});

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

  // Stable ref so the polling effect can read poll counts without putting them
  // in its dependency array (avoids double-scheduling on each count increment).
  const pollCountsRef = useRef(runningPollCounts);
  pollCountsRef.current = runningPollCounts;

  // Poll generation attempts for any level in 'running' state.
  // Uses cleanup-aware setTimeout (not setInterval) so it stops on unmount.
  // Gives up after 10 polls (50s) and surfaces "Still running… refresh to check".
  useEffect(() => {
    const runningEntries = Object.entries(lastAttempts).filter(([, a]) => a?.status === "running");
    if (runningEntries.length === 0 || !id) return undefined;
    const timeoutId = window.setTimeout(() => {
      void Promise.allSettled(
        runningEntries.map(async ([levelId]) => {
          if ((pollCountsRef.current[levelId] ?? 0) >= 10) return;
          setRunningPollCounts((prev) => ({ ...prev, [levelId]: (prev[levelId] ?? 0) + 1 }));
          await refreshAttempt(id, levelId);
        }),
      );
    }, 5000);
    return () => window.clearTimeout(timeoutId);
  }, [lastAttempts, id, refreshAttempt]);

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

  async function handleRevise() {
    if (!id || !pack) return;
    if (
      !window.confirm(
        `Revise "${pack.name}"? This moves it back to draft so you can edit it, ` +
          `then re-publish as a new version. Already-published assessments keep their ` +
          `current content; tenant clones of this set auto-update when you re-publish.`,
      )
    )
      return;
    setRevising(true);
    setReviseError(null);
    try {
      await adminApi(`/admin/packs/${id}/revise`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      setReviseError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to revise pack.",
      );
    } finally {
      setRevising(false);
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
      // eslint-disable-next-line no-console
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

  async function handleArchiveQuestion(questionId: string) {
    if (!window.confirm("Archive this question? It will no longer be served to candidates.")) return;
    setArchivingQuestion(questionId);
    try {
      await adminApi(`/admin/questions/${questionId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      });
      await fetchPack();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("archive-question error:", err instanceof AdminApiError ? err.apiError.message : err);
    } finally {
      setArchivingQuestion(null);
    }
  }

  async function handleBulkAction() {
    if (!bulkConfirm) return;
    const { levelId, action, ids } = bulkConfirm;
    setBulkConfirm(null);
    setBulkingLevel(levelId);
    setBulkResult(null);
    setBulkResultDetailsOpen(false);
    try {
      const result = await bulkUpdateQuestionStatus({ ids, status: action });
      setBulkResult({ levelId, updated: result.updated.length, ids: result.updated });
      setLevelSelections((prev) => ({ ...prev, [levelId]: new Set() }));
      await fetchPack();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "bulk-update error:",
        err instanceof AdminApiError ? err.apiError.message : err,
      );
    } finally {
      setBulkingLevel(null);
    }
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={[{ label: "Question Bank", href: "/admin/question-bank" }, "Pack"]} helpPage="admin.question_bank.pack">
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
      <AdminShell breadcrumbs={[{ label: "Question Bank", href: "/admin/question-bank" }, "Pack"]} helpPage="admin.question_bank.pack">
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
    <AdminShell breadcrumbs={[{ label: "Question Bank", href: "/admin/question-bank" }, pack.name]} helpPage="admin.question_bank.pack">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Pack header */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{levels.length} level{levels.length !== 1 ? "s" : ""}</Chip>
          </div>
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
            {isSuperAdmin && (
              <HelpTip helpId="admin.question_bank.pack.generate">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={() => navigate("/admin/generate-wizard")}
                >
                  ✦ Generate questions →
                </button>
              </HelpTip>
            )}
            {isSuperAdmin && pack.status !== "archived" && (
              <HelpTip helpId="admin.question_bank.pack.archive">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  onClick={() => void handleArchivePack()}
                  disabled={archivingPack}
                  style={{ color: "var(--aiq-color-danger)" }}
                >
                  {archivingPack ? "Archiving…" : "Archive pack"}
                </button>
              </HelpTip>
            )}
            {isSuperAdmin && pack.status === "draft" && (
              <HelpTip helpId="admin.question_bank.pack.publish">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-primary"
                  onClick={() => void handlePublish()}
                  disabled={publishing}
                >
                  {publishing ? "Publishing…" : "Publish pack"}
                </button>
              </HelpTip>
            )}
            {isSuperAdmin && pack.status === "published" && (
              <HelpTip helpId="admin.question_bank.pack.revise">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-primary"
                  onClick={() => void handleRevise()}
                  disabled={revising}
                >
                  {revising ? "Revising…" : "Revise (new version)"}
                </button>
              </HelpTip>
            )}
          </div>
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

        {reviseError && (
          <div
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {reviseError}
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
          </div>

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
                const levelFilter = levelFilters[level.id] ?? { status: "", type: "" };
                // Count per status/type for chip badges
                const statusCounts: Record<string, number> = {};
                const typeCounts: Record<string, number> = {};
                for (const q of levelQs) {
                  statusCounts[q.status] = (statusCounts[q.status] ?? 0) + 1;
                  typeCounts[q.type] = (typeCounts[q.type] ?? 0) + 1;
                }
                const filteredQs = levelQs.filter(
                  (q) =>
                    (levelFilter.status === "" || q.status === levelFilter.status) &&
                    (levelFilter.type === "" || q.type === levelFilter.type),
                );
                const setLevelStatus = (s: string) => {
                  setLevelFilters((prev) => ({
                    ...prev,
                    [level.id]: { ...(prev[level.id] ?? { status: "", type: "" }), status: s },
                  }));
                  setLevelSelections((prev) => ({ ...prev, [level.id]: new Set() }));
                };
                const setLevelType = (t: string) => {
                  setLevelFilters((prev) => ({
                    ...prev,
                    [level.id]: { ...(prev[level.id] ?? { status: "", type: "" }), type: t },
                  }));
                  setLevelSelections((prev) => ({ ...prev, [level.id]: new Set() }));
                };
                const resetLevelFilter = () =>
                  setLevelFilters((prev) => ({
                    ...prev,
                    [level.id]: { status: "", type: "" },
                  }));

                // Bulk selection helpers for this level
                const selection = levelSelections[level.id] ?? new Set<string>();
                const visibleIds = filteredQs.map((q) => q.id);
                const allFiltered = visibleIds.length > 0 && visibleIds.every((id) => selection.has(id));
                const someFiltered = !allFiltered && visibleIds.some((id) => selection.has(id));
                const selectedItems = filteredQs.filter((q) => selection.has(q.id));
                // Approve is enabled only when every selected question is ai_draft
                const canApprove = selectedItems.length > 0 && selectedItems.every((q) => q.status === "ai_draft");
                // Archive is enabled only when no selected question is already archived
                const canArchive = selectedItems.length > 0 && selectedItems.every((q) => q.status !== "archived");

                const toggleQuestion = (qId: string) => {
                  setLevelSelections((prev) => {
                    const cur = new Set(prev[level.id] ?? []);
                    if (cur.has(qId)) cur.delete(qId); else cur.add(qId);
                    return { ...prev, [level.id]: cur };
                  });
                };
                const toggleAllFiltered = () => {
                  setLevelSelections((prev) => {
                    const cur = new Set(prev[level.id] ?? []);
                    if (allFiltered) { visibleIds.forEach((id) => cur.delete(id)); }
                    else { visibleIds.forEach((id) => cur.add(id)); }
                    return { ...prev, [level.id]: cur };
                  });
                };
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
                        {lastAttempts[level.id] && (
                          <div data-help-id="admin.questions.attempt_status" style={{ marginTop: "2px" }}>
                            <GenerationAttemptLine
                              attempt={lastAttempts[level.id]}
                              detailsOpen={openAttemptDetails === level.id}
                              onToggleDetails={() =>
                                setOpenAttemptDetails((prev) =>
                                  prev === level.id ? null : level.id,
                                )
                              }
                              pollExhausted={
                                (runningPollCounts[level.id] ?? 0) >= 10 &&
                                lastAttempts[level.id]?.status === "running"
                              }
                            />
                          </div>
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
                        {/* Publish now auto-activates questions, so this is only
                            for drafts ADDED to an already-published pack. Show it
                            only when the level actually has draft questions to
                            activate — otherwise it's a dead button. */}
                        {isSuperAdmin &&
                          pack.status === "published" &&
                          levelQs.some((q) => q.status === "draft") && (
                            <HelpTip helpId="admin.question_bank.pack.activate_drafts">
                              <button
                                type="button"
                                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                                onClick={() => void handleActivateAll(level.id)}
                                disabled={activatingLevel === level.id}
                              >
                                {activatingLevel === level.id ? "Activating…" : "Activate drafts"}
                              </button>
                            </HelpTip>
                          )}
                      </div>
                    </div>

                    {/* Filter chips — per level, above the question list */}
                    {levelQs.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                          padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                          borderBottom: "1px solid var(--aiq-color-border)",
                          background: "var(--aiq-color-bg-raised)",
                        }}
                      >
                        {/* Status chips */}
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px" }}>
                          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 2 }}>Status:</span>
                          {(["", "ai_draft", "draft", "active", "archived"] as const).map((s) => {
                            const count = s === "" ? levelQs.length : (statusCounts[s] ?? 0);
                            const active = levelFilter.status === s;
                            const zero = s !== "" && count === 0;
                            return (
                              <button
                                key={s}
                                type="button"
                                disabled={zero}
                                onClick={() => !zero && setLevelStatus(s)}
                                style={{
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: "var(--aiq-text-xs)",
                                  padding: "2px 8px",
                                  borderRadius: "var(--aiq-radius-pill)",
                                  border: `1px solid ${active ? "var(--aiq-color-accent)" : "var(--aiq-color-border)"}`,
                                  background: active ? "var(--aiq-color-accent-soft)" : "transparent",
                                  color: active ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)",
                                  cursor: zero ? "default" : "pointer",
                                  opacity: zero ? 0.4 : 1,
                                  letterSpacing: "0.02em",
                                }}
                              >
                                {s || "All"}{s !== "" ? ` (${count})` : ""}
                              </button>
                            );
                          })}
                        </div>
                        {/* Type chips */}
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px" }}>
                          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 2 }}>Type:</span>
                          {(["", "mcq", "log_analysis", "scenario", "kql", "subjective"] as const).map((t) => {
                            const count = t === "" ? levelQs.length : (typeCounts[t] ?? 0);
                            const active = levelFilter.type === t;
                            const zero = t !== "" && count === 0;
                            return (
                              <button
                                key={t}
                                type="button"
                                disabled={zero}
                                onClick={() => !zero && setLevelType(t)}
                                style={{
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: "var(--aiq-text-xs)",
                                  padding: "2px 8px",
                                  borderRadius: "var(--aiq-radius-pill)",
                                  border: `1px solid ${active ? "var(--aiq-color-accent)" : "var(--aiq-color-border)"}`,
                                  background: active ? "var(--aiq-color-accent-soft)" : "transparent",
                                  color: active ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)",
                                  cursor: zero ? "default" : "pointer",
                                  opacity: zero ? 0.4 : 1,
                                  letterSpacing: "0.02em",
                                }}
                              >
                                {t || "All"}{t !== "" ? ` (${count})` : ""}
                              </button>
                            );
                          })}
                        </div>
                        {/* Master select-all for bulk actions — super_admin only */}
                        {isSuperAdmin && filteredQs.length > 0 && (
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", paddingTop: "2px" }}>
                            <input
                              type="checkbox"
                              id={`select-all-${level.id}`}
                              checked={allFiltered}
                              ref={(el) => { if (el) el.indeterminate = someFiltered; }}
                              onChange={toggleAllFiltered}
                              style={{ accentColor: "var(--aiq-color-accent)", cursor: "pointer" }}
                            />
                            <label
                              htmlFor={`select-all-${level.id}`}
                              style={{
                                fontFamily: "var(--aiq-font-mono)",
                                fontSize: "var(--aiq-text-xs)",
                                color: "var(--aiq-color-fg-muted)",
                                cursor: "pointer",
                                userSelect: "none",
                              }}
                            >
                              Select all filtered ({filteredQs.length})
                            </label>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Bulk action bar — shown when 1+ questions are selected */}
                    {selection.size > 0 && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                          background: "var(--aiq-color-accent-soft)",
                          borderBottom: "1px solid var(--aiq-color-accent)",
                          gap: "var(--aiq-space-md)",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--aiq-font-mono)",
                            fontSize: "var(--aiq-text-xs)",
                            color: "var(--aiq-color-accent)",
                            fontWeight: 500,
                          }}
                        >
                          {selection.size} selected
                        </span>
                        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="aiq-btn aiq-btn-outline aiq-btn-sm"
                            disabled={!canApprove || bulkingLevel === level.id}
                            title={canApprove ? undefined : "Only ai_draft questions can be approved"}
                            onClick={() =>
                              setBulkConfirm({ levelId: level.id, action: "active", ids: [...selection] })
                            }
                          >
                            Approve to active
                          </button>
                          <button
                            type="button"
                            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                            disabled={!canArchive || bulkingLevel === level.id}
                            title={canArchive ? undefined : "All selected questions are already archived"}
                            onClick={() =>
                              setBulkConfirm({ levelId: level.id, action: "archived", ids: [...selection] })
                            }
                            style={{ color: "var(--aiq-color-danger)" }}
                          >
                            {bulkingLevel === level.id ? "Working…" : "Archive"}
                          </button>
                          <button
                            type="button"
                            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                            onClick={() =>
                              setLevelSelections((prev) => ({ ...prev, [level.id]: new Set() }))
                            }
                          >
                            Clear selection
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Bulk result success banner */}
                    {bulkResult?.levelId === level.id && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                          background: "var(--aiq-color-success-soft)",
                          borderBottom: "1px solid var(--aiq-color-success-border, var(--aiq-color-success))",
                          gap: "var(--aiq-space-md)",
                        }}
                      >
                        <div>
                          <span
                            style={{
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                              fontWeight: 500,
                              color: "var(--aiq-color-success)",
                            }}
                          >
                            Updated {bulkResult.updated} question{bulkResult.updated !== 1 ? "s" : ""}.
                          </span>
                          {bulkResult.updated <= 20 && (
                            <>
                              {" "}
                              <button
                                type="button"
                                onClick={() => setBulkResultDetailsOpen((v) => !v)}
                                style={{
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: "var(--aiq-text-xs)",
                                  color: "var(--aiq-color-success)",
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: 0,
                                  textDecoration: "underline",
                                }}
                              >
                                {bulkResultDetailsOpen ? "Hide details" : "Show details"}
                              </button>
                              {bulkResultDetailsOpen && (
                                <pre
                                  style={{
                                    display: "block",
                                    marginTop: "4px",
                                    fontFamily: "var(--aiq-font-mono)",
                                    fontSize: "10px",
                                    color: "var(--aiq-color-fg-secondary)",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-all",
                                  }}
                                >
                                  {bulkResult.ids.join("\n")}
                                </pre>
                              )}
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                          onClick={() => setBulkResult(null)}
                          aria-label="Dismiss"
                        >
                          ✕
                        </button>
                      </div>
                    )}

                    {/* Questions list */}
                    {levelQs.length === 0 ? (
                      <div
                        style={{
                          padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                          color: "var(--aiq-color-fg-muted)",
                          fontFamily: "var(--aiq-font-sans)",
                          fontSize: "var(--aiq-text-sm)",
                          fontStyle: "italic",
                        }}
                      >
                        {isSuperAdmin
                          ? "No questions yet. Use the Generate Questions page to add the first batch."
                          : "No questions yet. The platform team curates this pack — questions will appear once added."}
                      </div>
                    ) : filteredQs.length === 0 ? (
                      <div
                        style={{
                          padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                          color: "var(--aiq-color-fg-muted)",
                          fontFamily: "var(--aiq-font-sans)",
                          fontSize: "var(--aiq-text-sm)",
                          fontStyle: "italic",
                        }}
                      >
                        No questions match this filter.{" "}
                        <button
                          type="button"
                          onClick={resetLevelFilter}
                          style={{
                            fontFamily: "var(--aiq-font-sans)",
                            fontSize: "var(--aiq-text-sm)",
                            color: "var(--aiq-color-accent)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                            textDecoration: "underline",
                            fontStyle: "italic",
                          }}
                        >
                          Reset filters
                        </button>
                        {isSuperAdmin ? " or use the Generate Questions page to add new ones." : "."}
                      </div>
                    ) : (
                      filteredQs.map((q, qi) => (
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
                            background: selection.has(q.id)
                              ? "var(--aiq-color-accent-soft)"
                              : "var(--aiq-color-bg-base)",
                            borderLeft: q.status === "ai_draft" ? "2px solid #d97706" : "2px solid transparent",
                          }}
                        >
                          {/* Row checkbox — super_admin only (curation); tenant admins are view-only */}
                          {isSuperAdmin && (
                            <input
                              type="checkbox"
                              checked={selection.has(q.id)}
                              onChange={() => toggleQuestion(q.id)}
                              style={{
                                flexShrink: 0,
                                marginRight: "var(--aiq-space-sm)",
                                marginTop: 3,
                                accentColor: "var(--aiq-color-accent)",
                                cursor: "pointer",
                              }}
                            />
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Primary line: topic → prompt → "Untitled" */}
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
                              {q.topic?.trim() || questionPrompt(q.content) || "Untitled"}
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
                            {/* Tertiary line: all KB-source citation chips */}
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
                            {isSuperAdmin && q.status !== "archived" && (
                              <button
                                type="button"
                                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                                disabled={archivingQuestion === q.id}
                                onClick={() => void handleArchiveQuestion(q.id)}
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
                              {isSuperAdmin ? "Edit" : "View"}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bulk action confirm modal */}
      {bulkConfirm !== null && (
        <>
          <div
            onClick={() => setBulkConfirm(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.40)",
              zIndex: 200,
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={bulkConfirm.action === "archived" ? "Confirm bulk archive" : "Confirm bulk approve"}
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 201,
              background: "var(--aiq-color-bg-base)",
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-lg)",
              padding: "var(--aiq-space-xl)",
              width: "min(480px, 90vw)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--aiq-space-md)",
            }}
          >
            <h3
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              {bulkConfirm.action === "archived"
                ? `Archive ${bulkConfirm.ids.length} question${bulkConfirm.ids.length !== 1 ? "s" : ""}?`
                : `Approve ${bulkConfirm.ids.length} question${bulkConfirm.ids.length !== 1 ? "s" : ""} to active?`}
            </h3>
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-secondary)",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {bulkConfirm.action === "archived" ? (
                <>
                  {bulkConfirm.ids.length} question{bulkConfirm.ids.length !== 1 ? "s" : ""} will no longer be
                  available to candidates. This cannot be undone in bulk — reversal must be
                  per-question. To reactivate an archived question, open its Edit page.
                </>
              ) : (
                <>
                  {bulkConfirm.ids.length} ai_draft question{bulkConfirm.ids.length !== 1 ? "s" : ""} will move to{" "}
                  <strong>active</strong> status and become immediately visible to the question
                  pool. Bulk approve skips per-question rubric review — ensure these questions
                  have been manually checked before confirming.
                </>
              )}
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "var(--aiq-space-sm)",
                marginTop: "var(--aiq-space-sm)",
              }}
            >
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
                onClick={() => setBulkConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-help-id={bulkConfirm.action === "archived" ? "admin.questions.bulk.archive" : "admin.questions.bulk.approve"}
                className={
                  bulkConfirm.action === "archived"
                    ? "aiq-btn aiq-btn-ghost"
                    : "aiq-btn aiq-btn-primary"
                }
                onClick={() => void handleBulkAction()}
                style={bulkConfirm.action === "archived" ? { color: "var(--aiq-color-danger)" } : undefined}
              >
                {bulkConfirm.action === "archived"
                  ? `Archive ${bulkConfirm.ids.length}`
                  : `Approve ${bulkConfirm.ids.length}`}
              </button>
            </div>
          </div>
        </>
      )}

    </AdminShell>
  );
}
