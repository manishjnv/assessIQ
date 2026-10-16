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

import { packStatusDisplay } from "../lib/labels.js";
import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chip, ConfirmDialog, Modal, formatDate } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, bulkUpdateQuestionStatus } from "../api.js";
import { useAdminSession } from "../session.js";
import { type GenerationAttempt, type Level, type Pack, type QuestionItem, type PackDetailResponse, type QuestionsResponse, packStatusColor } from "./pack-detail/shared.js";
import { LevelPanel } from "./pack-detail/LevelPanel.js";

// Chip display order differs from the registry order; "" = all types.
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
        err instanceof AdminApiError ? err.apiError.message : "Failed to load question set.",
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
    // Route is super_admin-only server-side; skip for tenant admins (would 403).
    const attempts: Record<string, GenerationAttempt | null> = {};
    if (!isSuperAdmin) {
      setLastAttempts(attempts);
      return;
    }
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
  }, [id, isSuperAdmin]);

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
        err instanceof AdminApiError ? err.apiError.message : "Failed to publish question set.",
      );
    } finally {
      setPublishing(false);
    }
  }

  // Pending confirmation (ConfirmDialog): the dialog runs `run` on confirm.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => void;
  } | null>(null);

  function handleRevise() {
    if (!id || !pack) return;
    setPendingConfirm({
      title: "Revise question set",
      body:
        `Revise "${pack.name}"? This moves it back to draft so you can edit it, ` +
        `then re-publish as a new version. Already-published assessments keep their ` +
        `current content; organisation copies of this set auto-update when you re-publish.`,
      confirmLabel: "Revise",
      run: () => void doRevise(),
    });
  }

  async function doRevise() {
    if (!id) return;
    setRevising(true);
    setReviseError(null);
    try {
      await adminApi(`/admin/packs/${id}/revise`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      setReviseError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to revise question set.",
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

  function handleArchivePack() {
    if (!id || !pack) return;
    setPendingConfirm({
      title: "Archive question set",
      body: `Are you sure? This will archive "${pack.name}".`,
      confirmLabel: "Archive",
      danger: true,
      run: () => void doArchivePack(),
    });
  }

  async function doArchivePack() {
    if (!id) return;
    setArchivingPack(true);
    setArchivePackError(null);
    try {
      await adminApi(`/admin/packs/${id}/archive`, { method: "POST" });
      await fetchPack();
    } catch (err) {
      setArchivePackError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to archive question set.",
      );
    } finally {
      setArchivingPack(false);
    }
  }

  function handleArchiveQuestion(questionId: string) {
    setPendingConfirm({
      title: "Archive question",
      body: "Archive this question? It will no longer be served to candidates.",
      confirmLabel: "Archive question",
      danger: true,
      run: () => void doArchiveQuestion(questionId),
    });
  }

  async function doArchiveQuestion(questionId: string) {
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
      <AdminShell breadcrumbs={[{ label: "Question bank", href: "/admin/question-bank" }, "Question set"]} helpPage="admin.question_bank.pack">
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
      <AdminShell breadcrumbs={[{ label: "Question bank", href: "/admin/question-bank" }, "Question set"]} helpPage="admin.question_bank.pack">
        <div
          style={{
            color: "var(--aiq-color-danger)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {error ?? "Question set not found."}
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
    <AdminShell breadcrumbs={[{ label: "Question bank", href: "/admin/question-bank" }, pack.name]} helpPage="admin.question_bank.pack">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Pack header */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{levels.length} {levels.length !== 1 ? "difficulty levels" : "difficulty level"}</Chip>
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
                {packStatusDisplay(pack.status).label}
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
              {formatDate(pack.created_at)}
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
                  {archivingPack ? "Archiving…" : "Archive question set"}
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
                  {publishing ? "Publishing…" : "Publish question set"}
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
                No difficulty levels yet. Add a difficulty level to start building this question set.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
              {levels.map((level) => (
                <LevelPanel
                  key={level.id}
                  level={level}
                  pack={pack}
                  levelQs={questionsByLevel[level.id] ?? []}
                  isSuperAdmin={isSuperAdmin}
                  navigate={navigate}
                  levelFilters={levelFilters}
                  setLevelFilters={setLevelFilters}
                  levelSelections={levelSelections}
                  setLevelSelections={setLevelSelections}
                  lastAttempts={lastAttempts}
                  openAttemptDetails={openAttemptDetails}
                  setOpenAttemptDetails={setOpenAttemptDetails}
                  runningPollCounts={runningPollCounts}
                  activatingLevel={activatingLevel}
                  handleActivateAll={handleActivateAll}
                  archivingQuestion={archivingQuestion}
                  handleArchiveQuestion={handleArchiveQuestion}
                  bulkingLevel={bulkingLevel}
                  setBulkConfirm={setBulkConfirm}
                  bulkResult={bulkResult}
                  setBulkResult={setBulkResult}
                  bulkResultDetailsOpen={bulkResultDetailsOpen}
                  setBulkResultDetailsOpen={setBulkResultDetailsOpen}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bulk action confirm modal */}
      <Modal
        open={bulkConfirm !== null}
        onClose={() => setBulkConfirm(null)}
        title={
          bulkConfirm === null
            ? ""
            : bulkConfirm.action === "archived"
              ? `Archive ${bulkConfirm.ids.length} question${bulkConfirm.ids.length !== 1 ? "s" : ""}?`
              : `Approve ${bulkConfirm.ids.length} question${bulkConfirm.ids.length !== 1 ? "s" : ""} to active?`
        }
      >
        {bulkConfirm !== null && (
          <>
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
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ""}
        body={pendingConfirm?.body ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? ""}
        danger={pendingConfirm?.danger ?? false}
        busy={revising || archivingPack || archivingQuestion !== null}
        onConfirm={() => {
          const run = pendingConfirm?.run;
          setPendingConfirm(null);
          run?.();
        }}
        onCancel={() => setPendingConfirm(null)}
      />

    </AdminShell>
  );
}
