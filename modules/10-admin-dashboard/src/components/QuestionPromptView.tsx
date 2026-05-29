// AssessIQ — QuestionPromptView
//
// Renders ONLY the candidate-facing stimulus for a question — the same thing
// the candidate saw while taking the assessment — with NO answer key. This is
// the "Question" zone of the admin attempt-audit card; the answer key (correct
// option, rationale, expected findings, sample solution, expected keywords,
// per-step expected, rubric) is rendered separately by <ExpectedAnswerView>.
//
// Keeping the two strictly separate is the whole point of the audit redesign:
// the admin must be able to see, at a glance, (1) what was asked, (2) what was
// expected, (3) what the candidate wrote, (4) how the AI scored it — without
// the answer key bleeding into the question prompt.
//
// INVARIANTS:
//  - Read-only. Never crashes on malformed content (per-section fallbacks).
//  - Emits NO answer-key material (correct/rationale/expected*/sample_solution).

import React from "react";
import { cleanText, unescapeJsonString, safeStr, safeArr, obj, JsonFallback, Chip, OPTION_LABELS } from "./question-format.js";

export interface QuestionPromptViewProps {
  type: string;
  content: unknown;
}

const PROMPT_TEXT_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-md)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
};

function PromptText({ value }: { value: unknown }): React.ReactElement {
  const s = safeStr(value);
  return s != null ? <p style={PROMPT_TEXT_STYLE}>{cleanText(s)}</p> : <JsonFallback value={value} />;
}

// ── per-type prompt renderers (answer-key stripped) ───────────────────────────

function McqPrompt({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const options = safeArr<unknown>(c.options);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <PromptText value={c.question} />
      {options != null && (
        <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          {options.map((opt, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--aiq-space-sm)",
                padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                borderRadius: 4,
                background: "var(--aiq-color-bg-secondary, #f8f8f8)",
              }}
            >
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", fontWeight: 700, minWidth: 20, color: "var(--aiq-color-fg-muted)" }}>
                {OPTION_LABELS[i] ?? i}
              </span>
              <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)", whiteSpace: "pre-wrap" }}>
                {typeof opt === "string" ? cleanText(opt) : JSON.stringify(opt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function KqlPrompt({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const tables = safeArr<unknown>(c.tables);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <PromptText value={c.question} />
      {tables != null && tables.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
          {tables.map((t, i) => (
            <Chip key={i} label={typeof t === "string" ? t : JSON.stringify(t)} mono />
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioPrompt({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const title = safeStr(c.title);
  const intro = safeStr(c.intro);
  const steps = safeArr<unknown>(c.steps);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {title != null && (
        <h3 style={{ margin: 0, fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-lg)", fontWeight: 400 }}>
          {cleanText(title)}
        </h3>
      )}
      {intro != null && <p style={PROMPT_TEXT_STYLE}>{cleanText(intro)}</p>}
      {steps != null && steps.length > 0 && (
        <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {steps.map((step, i) => {
            const s = obj(step);
            const prompt = s ? safeStr(s.prompt) : null;
            // Deliberately NO `expected` — that is answer-key, shown in ExpectedAnswerView.
            return (
              <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", whiteSpace: "pre-wrap" }}>
                {prompt != null ? cleanText(prompt) : <JsonFallback value={step} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function LogAnalysisPrompt({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const logFormat = safeStr(c.log_format);
  const logExcerpt = safeStr(c.log_excerpt);
  const hint = safeStr(c.hint);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <PromptText value={c.question} />
      {(logFormat != null || logExcerpt != null) && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          {logFormat != null && <div><Chip label={logFormat} mono /></div>}
          {logExcerpt != null && (
            <pre
              style={{
                margin: 0,
                padding: "var(--aiq-space-sm)",
                background: "var(--aiq-color-bg-secondary, #f8f8f8)",
                borderRadius: 4,
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                whiteSpace: "pre",
                overflowX: "auto",
                color: "var(--aiq-color-fg-primary)",
                border: "1px solid var(--aiq-color-border, #e5e7eb)",
              }}
            >
              {unescapeJsonString(logExcerpt)}
            </pre>
          )}
        </div>
      )}
      {hint != null && (
        <div
          style={{
            padding: "var(--aiq-space-sm)",
            borderRadius: 4,
            background: "var(--aiq-color-bg-secondary, #f8f8f8)",
            borderLeft: "3px solid var(--aiq-color-border, #e5e7eb)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            color: "var(--aiq-color-fg-muted)",
            whiteSpace: "pre-wrap",
          }}
        >
          <span style={{ fontWeight: 600, marginRight: "var(--aiq-space-xs)" }}>Hint:</span>
          {cleanText(hint)}
        </div>
      )}
    </div>
  );
}

export function QuestionPromptView({ type, content }: QuestionPromptViewProps): React.ReactElement {
  if (typeof content === "string") {
    return <p style={PROMPT_TEXT_STYLE}>{content}</p>;
  }
  const c = obj(content);
  if (c === null) return <JsonFallback value={content} />;

  switch (type) {
    case "mcq":
      return <McqPrompt c={c} />;
    case "subjective":
      return <PromptText value={c.question} />;
    case "kql":
      return <KqlPrompt c={c} />;
    case "scenario":
      return <ScenarioPrompt c={c} />;
    case "log_analysis":
      return <LogAnalysisPrompt c={c} />;
    default:
      return <JsonFallback value={content} />;
  }
}

QuestionPromptView.displayName = "QuestionPromptView";
