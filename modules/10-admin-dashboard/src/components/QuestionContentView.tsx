// AssessIQ — QuestionContentView
//
// Read-only renderer for question content. Renders a type-aware layout
// for each of the five question types: mcq, subjective, kql, scenario,
// log_analysis. Falls back to a JSON pre-block if content is malformed
// or the type is unrecognised.
//
// INVARIANTS:
//  - No content editing. Read-only.
//  - Never crashes on malformed content — each section falls back independently.

import React from "react";

export interface QuestionContentViewProps {
  type: string;
  content: unknown;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safeStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeArr<T>(v: unknown): T[] | null {
  return Array.isArray(v) ? (v as T[]) : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function JsonFallback({ value }: { value: unknown }): React.ReactElement {
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

// ── MCQ ──────────────────────────────────────────────────────────────────────

const OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

function McqView({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const question = safeStr(c.question);
  const options = safeArr<unknown>(c.options);
  const correct = typeof c.correct === "number" ? c.correct : null;
  const rationale = safeStr(c.rationale);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {question != null ? (
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6 }}>
          {question}
        </p>
      ) : (
        <JsonFallback value={c.question} />
      )}

      {options != null ? (
        <ol
          style={{
            margin: 0,
            paddingLeft: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "var(--aiq-space-xs)",
          }}
        >
          {options.map((opt, i) => {
            const isCorrect = correct === i;
            return (
              <li
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "var(--aiq-space-sm)",
                  padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                  borderRadius: 4,
                  background: isCorrect
                    ? "var(--aiq-color-success-bg, #d1fae5)"
                    : "var(--aiq-color-bg-secondary, #f8f8f8)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    fontWeight: 700,
                    minWidth: 20,
                    color: isCorrect ? "var(--aiq-color-success, #065f46)" : "var(--aiq-color-fg-muted)",
                  }}
                >
                  {OPTION_LABELS[i] ?? i}
                  {isCorrect ? " ✓" : ""}
                </span>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    color: isCorrect ? "var(--aiq-color-success, #065f46)" : "var(--aiq-color-fg-primary)",
                  }}
                >
                  {typeof opt === "string" ? opt : JSON.stringify(opt)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <JsonFallback value={c.options} />
      )}

      {rationale != null && (
        <div
          style={{
            padding: "var(--aiq-space-sm)",
            borderLeft: "3px solid var(--aiq-color-border, #e5e7eb)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          <span style={{ fontWeight: 600, marginRight: "var(--aiq-space-xs)" }}>Rationale:</span>
          {rationale}
        </div>
      )}
    </div>
  );
}

// ── Subjective ───────────────────────────────────────────────────────────────

function SubjectiveView({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const question = safeStr(c.question);
  return question != null ? (
    <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6 }}>
      {question}
    </p>
  ) : (
    <JsonFallback value={c.question} />
  );
}

// ── KQL ──────────────────────────────────────────────────────────────────────

function Chip({ label, mono }: { label: string; mono?: boolean }): React.ReactElement {
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

function KqlView({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const question = safeStr(c.question);
  const tables = safeArr<unknown>(c.tables);
  const keywords = safeArr<unknown>(c.expected_keywords);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {question != null ? (
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6 }}>
          {question}
        </p>
      ) : (
        <JsonFallback value={c.question} />
      )}

      {tables != null && tables.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--aiq-color-fg-muted)",
              marginBottom: "var(--aiq-space-xs)",
            }}
          >
            Tables
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
            {tables.map((t, i) => (
              <Chip key={i} label={typeof t === "string" ? t : JSON.stringify(t)} mono />
            ))}
          </div>
        </div>
      )}

      {keywords != null && keywords.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--aiq-color-fg-muted)",
              marginBottom: "var(--aiq-space-xs)",
            }}
          >
            Expected keywords
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
            {keywords.map((k, i) => (
              <Chip key={i} label={typeof k === "string" ? k : JSON.stringify(k)} mono />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scenario ─────────────────────────────────────────────────────────────────

interface ScenarioStep {
  prompt?: unknown;
  expected?: unknown;
}

function ScenarioView({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const title = safeStr(c.title);
  const intro = safeStr(c.intro);
  const steps = safeArr<unknown>(c.steps);
  const stepDependency = safeStr(c.step_dependency);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {title != null ? (
        <h3
          style={{
            margin: 0,
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-lg)",
            fontWeight: 400,
          }}
        >
          {title}
        </h3>
      ) : (
        <JsonFallback value={c.title} />
      )}

      {stepDependency && (
        <div>
          <Chip label={`step_dependency: ${stepDependency}`} />
        </div>
      )}

      {intro != null && (
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6 }}>
          {intro}
        </p>
      )}

      {steps != null && steps.length > 0 && (
        <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {steps.map((step, i) => {
            const s = obj(step);
            const prompt = s ? safeStr(s.prompt) : null;
            const expected = s ? safeStr(s.expected) : null;
            return (
              <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
                {prompt != null ? (
                  <span>{prompt}</span>
                ) : (
                  <JsonFallback value={step} />
                )}
                {expected != null && (
                  <div
                    style={{
                      marginTop: "var(--aiq-space-xs)",
                      padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                      borderLeft: "3px solid var(--aiq-color-border, #e5e7eb)",
                      color: "var(--aiq-color-fg-muted)",
                      fontSize: "var(--aiq-text-xs)",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>Expected: </span>
                    {expected}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ── LogAnalysis ───────────────────────────────────────────────────────────────

function LogAnalysisView({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const question = safeStr(c.question);
  const logFormat = safeStr(c.log_format);
  const logExcerpt = safeStr(c.log_excerpt);
  const expectedFindings = safeArr<unknown>(c.expected_findings);
  const sampleSolution = safeStr(c.sample_solution);
  const hint = safeStr(c.hint);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {/* Prompt */}
      {question != null ? (
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6 }}>
          {question}
        </p>
      ) : (
        <JsonFallback value={c.question} />
      )}

      {/* Log format badge + excerpt */}
      {(logFormat != null || logExcerpt != null) && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          {logFormat != null && (
            <div>
              <Chip label={logFormat} mono />
            </div>
          )}
          {logExcerpt != null ? (
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
              {logExcerpt}
            </pre>
          ) : (
            <JsonFallback value={c.log_excerpt} />
          )}
        </div>
      )}

      {/* Expected findings */}
      {expectedFindings != null && expectedFindings.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--aiq-color-fg-muted)",
              marginBottom: "var(--aiq-space-xs)",
            }}
          >
            Expected findings
          </div>
          <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
            {expectedFindings.map((f, i) => (
              <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.5 }}>
                {typeof f === "string" ? f : JSON.stringify(f)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Sample solution — collapsed */}
      {sampleSolution != null && (
        <details style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
          <summary
            style={{
              cursor: "pointer",
              color: "var(--aiq-color-fg-muted)",
              userSelect: "none",
              padding: "var(--aiq-space-xs) 0",
            }}
          >
            Sample solution
          </summary>
          <p
            style={{
              margin: "var(--aiq-space-xs) 0 0",
              lineHeight: 1.6,
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            {sampleSolution}
          </p>
        </details>
      )}

      {/* Hint */}
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
          }}
        >
          <span style={{ fontWeight: 600, marginRight: "var(--aiq-space-xs)" }}>Hint:</span>
          {hint}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function QuestionContentView({ type, content }: QuestionContentViewProps): React.ReactElement {
  // If content is a raw string, render as-is.
  if (typeof content === "string") {
    return (
      <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
        {content}
      </p>
    );
  }

  const c = obj(content);

  // Unrecognised type or null content — full JSON fallback.
  if (c === null) {
    return <JsonFallback value={content} />;
  }

  switch (type) {
    case "mcq":
      return <McqView c={c} />;
    case "subjective":
      return <SubjectiveView c={c} />;
    case "kql":
      return <KqlView c={c} />;
    case "scenario":
      return <ScenarioView c={c} />;
    case "log_analysis":
      return <LogAnalysisView c={c} />;
    default:
      return <JsonFallback value={content} />;
  }
}
