// AssessIQ — shared question-format helpers.
//
// Pure text-normalisation + small presentational primitives shared by the
// admin review components that split a question into demarcated zones:
//   - QuestionPromptView   (what the candidate saw — prompt only)
//   - ExpectedAnswerView   (the answer key + rubric — what we grade against)
//
// QuestionContentView (used by the question editor preview) keeps its own
// private copies intentionally — it is a separate, already-shipped consumer
// and we do not want to perturb it. These exports are the canonical versions
// for the new attempt-audit zones.
//
// INVARIANTS:
//  - Never crashes on malformed content — every accessor is null-tolerant.
//  - Never renders raw JSON to the admin except via the explicit <JsonFallback>.

import React from "react";

// ── value accessors ──────────────────────────────────────────────────────────

export function safeStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function safeArr<T>(v: unknown): T[] | null {
  return Array.isArray(v) ? (v as T[]) : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export const OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

// ── text normalisation ───────────────────────────────────────────────────────

/**
 * Decode JSON double-escape artifacts and common HTML entities.
 * Order matters: double-backslash must be resolved before \\n / \\t so that
 * a triple-escaped sequence like "\\\\n" → "\n" (literal) and "\\n" → newline.
 */
export function unescapeJsonString(s: string): string {
  return s
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/** Strip markdown syntax markers while preserving structure. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1")
    .replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[*-]\s+/gm, "• ")
    .replace(/^(\d+)\.\s+/gm, "$1) ")
    .replace(/\n{3,}/g, "\n\n");
}

/** Full normalisation: decode JSON/HTML escapes, then strip markdown markers. */
export function cleanText(s: string): string {
  return stripMarkdown(unescapeJsonString(s));
}

// ── shared presentational primitives ─────────────────────────────────────────

export function JsonFallback({ value }: { value: unknown }): React.ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        padding: "var(--aiq-space-sm)",
        background: "var(--aiq-color-bg-secondary, #f8f8f8)",
        borderRadius: 4,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        color: "var(--aiq-color-fg-muted)",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Chip({ label, mono }: { label: string; mono?: boolean }): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        background: "var(--aiq-color-bg-secondary, #f0f0f0)",
        fontFamily: mono ? "var(--aiq-font-mono)" : "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-xs)",
        color: "var(--aiq-color-fg-primary)",
        border: "1px solid var(--aiq-color-border, #e5e7eb)",
      }}
    >
      {label}
    </span>
  );
}

/** Uppercase mono section sublabel used to head each zone's sub-blocks. */
export const SUBLABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
  marginBottom: "var(--aiq-space-xs)",
};
