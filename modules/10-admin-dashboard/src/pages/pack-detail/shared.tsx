import React from "react";
import { formatDateTime } from "@assessiq/ui-system";
import type { QuestionType } from "@assessiq/question-types";

export const TYPE_CHIPS: readonly ("" | Extract<QuestionType, string>)[] = ["", "mcq", "log_analysis", "scenario", "kql", "subjective", "numeric", "multi_select", "ordering", "structured_case"];

type PackStatus = "draft" | "published" | "archived";

type GenerationAttemptStatus = "success" | "partial" | "failed" | "running";

export interface GenerationAttempt {
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

export interface Level {
  id: string;
  label: string;
  description: string | null;
  order: number;
}

export interface Pack {
  id: string;
  name: string;
  domain: string;
  status: PackStatus;
  version: number;
  created_at: string;
  description: string | null;
}

export interface QuestionItem {
  id: string;
  level_id: string;
  type: string;
  status: string;
  topic?: string | null;
  points?: number;
  created_at?: string;
  content: Record<string, unknown>;
  knowledge_base_sources?: Array<{ id: string; name: string; citation: string; url?: string }>;
  /** FU-C13: difficulty tags from the generator (null on human-authored rows). */
  cognitive_level?: string | null;
  nice_task_id?: string | null;
}

export interface PackDetailResponse {
  pack: Pack;
  levels: Level[];
}

export interface QuestionsResponse {
  items: QuestionItem[];
  total: number;
}

export function packStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "published":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "archived":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
  }
}

export function questionPrompt(content: Record<string, unknown>): string {
  const c = content as { prompt?: string; stem?: string; scenario?: string; question?: string; title?: string };
  return c.prompt ?? c.stem ?? c.scenario ?? c.question ?? c.title ?? "";
}

/** Format a date string as relative (< 30 days) or absolute (≥ 30 days). */

/** Format a date string as relative (< 30 min) or absolute (≥ 30 min). */

/** Format milliseconds as "Xm Ys" for display. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Renders the last-attempt status line shown below the level header. */
export function GenerationAttemptLine({
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

  const dateStr = formatDateTime(started_at);
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
              fontSize: "var(--aiq-text-xs)",
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

