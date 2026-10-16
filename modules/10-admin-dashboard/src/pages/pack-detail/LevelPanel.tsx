import React from "react";
import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { Chip, formatRelative } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { questionTypeLabel, questionStatusLabel } from "../../lib/labels.js";
import { TYPE_CHIPS, type GenerationAttempt, type Level, type Pack, type QuestionItem, questionPrompt, GenerationAttemptLine } from "./shared.js";

export interface LevelPanelProps {
  level: Level;
  pack: Pack;
  levelQs: QuestionItem[];
  isSuperAdmin: boolean;
  navigate: NavigateFunction;
  levelFilters: Record<string, { status: string; type: string }>;
  setLevelFilters: Dispatch<SetStateAction<Record<string, { status: string; type: string }>>>;
  levelSelections: Record<string, Set<string>>;
  setLevelSelections: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  lastAttempts: Record<string, GenerationAttempt | null>;
  openAttemptDetails: string | null;
  setOpenAttemptDetails: Dispatch<SetStateAction<string | null>>;
  runningPollCounts: Record<string, number>;
  activatingLevel: string | null;
  handleActivateAll: (levelId: string) => Promise<void>;
  archivingQuestion: string | null;
  handleArchiveQuestion: (questionId: string) => void;
  bulkingLevel: string | null;
  setBulkConfirm: Dispatch<SetStateAction<{ levelId: string; action: "active" | "archived"; ids: string[] } | null>>;
  bulkResult: { levelId: string; updated: number; ids: string[] } | null;
  setBulkResult: Dispatch<SetStateAction<{ levelId: string; updated: number; ids: string[] } | null>>;
  bulkResultDetailsOpen: boolean;
  setBulkResultDetailsOpen: Dispatch<SetStateAction<boolean>>;
}

export function LevelPanel(props: LevelPanelProps): React.ReactElement {
  const {
    level, pack, levelQs, isSuperAdmin, navigate, levelFilters, setLevelFilters,
    levelSelections, setLevelSelections, lastAttempts, openAttemptDetails,
    setOpenAttemptDetails, runningPollCounts, activatingLevel, handleActivateAll,
    archivingQuestion, handleArchiveQuestion, bulkingLevel, setBulkConfirm,
    bulkResult, setBulkResult, bulkResultDetailsOpen, setBulkResultDetailsOpen,
  } = props;

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
            <div data-help-id="admin.question_bank.pack.attempt_status" style={{ marginTop: "2px" }}>
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
            {TYPE_CHIPS.map((t) => {
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
            ? "No questions yet. Use the Generate questions page to add the first batch."
            : "No questions yet. The platform team curates this question set — questions will appear once added."}
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
                {questionTypeLabel(q.type)} · {questionStatusLabel(q.status)}
                {q.points != null ? ` · ${q.points} pts` : ""}
                {q.created_at ? ` · ${formatRelative(q.created_at)}` : ""}
              </span>
              {/* FU-C13: Bloom + NICE chips (generator tags; absent on human-authored rows) */}
              {(q.cognitive_level || q.nice_task_id) && (
                <div data-help-id="admin.question_bank.pack.difficulty" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                  {q.cognitive_level && <Chip>Bloom: {q.cognitive_level}</Chip>}
                  {q.nice_task_id && <Chip>NICE: {q.nice_task_id}</Chip>}
                </div>
              )}
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
}
