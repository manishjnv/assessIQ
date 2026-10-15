// Admin candidate-answer renderers: one per question type (RW-54a step 7).
// Add a type to packages/question-types and `satisfies` fails here until the
// new type has an entry. A renderer returns null when the answer shape is not
// readable; the caller then shows the generic "no readable preview" note.
import React from "react";
import type { QuestionType } from "@assessiq/question-types";
import { StructuredCaseView } from "../components/StructuredCaseView.js";

export type QuestionRenderer = (props: { content: unknown; answer: unknown }) => React.ReactElement | null;

export const ANSWER_TEXT_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-md)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  color: "var(--aiq-color-fg-secondary)",
  borderLeft: "2px solid var(--aiq-color-border)",
  paddingLeft: "var(--aiq-space-md)",
};

export const ANSWER_SUBLABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
  marginBottom: "var(--aiq-space-2xs)",
};

export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

export function asAnswerObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function NoAnswer({ label }: { label: string }): React.ReactElement {
  return (
    <p style={{ ...ANSWER_TEXT_STYLE, fontStyle: "italic", color: "var(--aiq-color-fg-muted)" }}>
      {label}
    </p>
  );
}


function mcqAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  // canonical: { selected: number }; tolerate a bare numeric index too.
  const selected =
    typeof a?.selected === "number" ? a.selected :
    typeof answer === "number" ? answer : null;
  if (selected === null) return null;
  const c = asAnswerObj(content);
  const options = Array.isArray(c?.options) ? (c!.options as unknown[]) : [];
  const correct = typeof c?.correct === "number" ? c!.correct : null;
  const optText = typeof options[selected] === "string" ? (options[selected] as string) : "";
  const isCorrect = correct === null ? null : selected === correct;
  const mark = isCorrect === true ? " ✓" : isCorrect === false ? " ✗" : "";
  const markColor = isCorrect === true ? "var(--aiq-color-success, #065f46)" : isCorrect === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)";
  return (
    <p style={ANSWER_TEXT_STYLE}>
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: markColor }}>
        {OPTION_LETTERS[selected] ?? selected}{mark}
      </span>
      {optText}
    </p>
  );
}

function structuredCaseAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const given = asAnswerObj(a?.steps);
  if (given === null) return null;
  if (Object.values(given).every((v) => !Array.isArray(v) || v.length === 0)) return <NoAnswer label="No steps answered." />;
  const c = asAnswerObj(content);
  if (c === null) return null;
  return <StructuredCaseView c={c} mode="answer" withCase={false} answer={answer} />;
}

function orderingAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const ord = Array.isArray(a?.order) ? (a!.order as unknown[]).filter((x): x is number => typeof x === "number") : null;
  if (ord === null) return null;
  if (ord.length === 0) return <NoAnswer label="No order submitted." />;
  const c = asAnswerObj(content);
  const items = Array.isArray(c?.items) ? (c!.items as unknown[]) : [];
  const key = Array.isArray(c?.correct_order) ? (c!.correct_order as unknown[]) : [];
  const text = (i: unknown): string => (typeof i === "number" && typeof items[i] === "string" ? (items[i] as string) : "");
  const col: React.CSSProperties = { flex: 1, minWidth: 200 };
  return (
    <div style={{ display: "flex", gap: "var(--aiq-space-lg)", flexWrap: "wrap" }}>
      <div style={col}>
        <div style={ANSWER_SUBLABEL_STYLE}>Candidate order</div>
        <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
          {ord.map((i, pos) => {
            const ok = key.length === 0 ? null : key[pos] === i;
            return (
              <li key={pos} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: ok === true ? "var(--aiq-color-success, #065f46)" : ok === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-secondary)" }}>
                {text(i)}{ok === true ? " ✓" : ok === false ? " ✗" : ""}
              </li>
            );
          })}
        </ol>
      </div>
      {key.length > 0 && (
        <div style={col}>
          <div style={ANSWER_SUBLABEL_STYLE}>Correct order</div>
          <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
            {key.map((i, pos) => (
              <li key={pos} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>{text(i)}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function numericAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const v = typeof answer === "number" ? answer : typeof a?.value === "number" ? a.value : null;
  if (v === null) return null;
  const c = asAnswerObj(content);
  const want = typeof c?.answer === "number" ? c.answer : null;
  const tol = typeof c?.tolerance === "number" && c.tolerance >= 0 ? c.tolerance : 0;
  const ok = want === null ? null : Math.abs(v - want) <= tol + 1e-9;
  const unit = typeof c?.unit === "string" ? ` ${c.unit}` : "";
  return (
    <p style={ANSWER_TEXT_STYLE}>
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: ok === true ? "var(--aiq-color-success, #065f46)" : ok === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)" }}>
        {v}{unit}{ok === true ? " ✓" : ok === false ? " ✗" : ""}
      </span>
    </p>
  );
}

function multiSelectAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const sel = Array.isArray(a?.selected) ? (a!.selected as unknown[]).filter((x): x is number => typeof x === "number") : Array.isArray(answer) ? (answer as unknown[]).filter((x): x is number => typeof x === "number") : null;
  if (sel === null) return null;
  if (sel.length === 0) return <NoAnswer label="No options selected." />;
  const c = asAnswerObj(content);
  const options = Array.isArray(c?.options) ? (c!.options as unknown[]) : [];
  const key = Array.isArray(c?.correct) ? (c!.correct as unknown[]) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
      {sel.map((i) => {
        const ok = key === null ? null : key.includes(i);
        return (
          <p key={i} style={ANSWER_TEXT_STYLE}>
            <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: ok === true ? "var(--aiq-color-success, #065f46)" : ok === false ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)" }}>
              {OPTION_LETTERS[i] ?? i}{ok === true ? " ✓" : ok === false ? " ✗" : ""}
            </span>
            {typeof options[i] === "string" ? (options[i] as string) : ""}
          </p>
        );
      })}
    </div>
  );
}

function subjectiveAnswer({ answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const text = typeof a?.response === "string" ? a.response : null;
  if (text === null) return null;
  return text.trim() === "" ? <NoAnswer label="No answer submitted." /> : <p style={ANSWER_TEXT_STYLE}>{text}</p>;
}

function kqlAnswer({ content, answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const query = typeof a?.query === "string" ? a.query : null;
  if (query === null) return null;
  if (query.trim() === "") return <NoAnswer label="No query submitted." />;
  // FU-D15 (2026-10-06): no auto-grader exists for KQL yet (manual score
  // only) — this is a read-only aid next to ManualScoreForm, not a score.
  const c = asAnswerObj(content);
  const expectedKeywords = Array.isArray(c?.expected_keywords)
    ? (c!.expected_keywords as unknown[]).filter((k): k is string => typeof k === "string" && k.trim() !== "")
    : [];
  const queryLower = query.toLowerCase();
  const hits = expectedKeywords.filter((k) => queryLower.includes(k.toLowerCase()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
      <pre
        style={{
          margin: 0,
          padding: "var(--aiq-space-sm)",
          background: "var(--aiq-color-bg-secondary, #f8f8f8)",
          borderRadius: 4,
          fontFamily: "var(--aiq-font-mono)",
          fontSize: "var(--aiq-text-xs)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--aiq-color-fg-primary)",
          border: "1px solid var(--aiq-color-border, #e5e7eb)",
        }}
      >
        {query}
      </pre>
      {expectedKeywords.length > 0 && (
        <p style={{ ...ANSWER_TEXT_STYLE, fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          Keyword hits ({hits.length}/{expectedKeywords.length}): {expectedKeywords.map((k) => (
            <span
              key={k}
              style={{
                display: "inline-block",
                marginRight: "var(--aiq-space-xs)",
                padding: "1px 6px",
                borderRadius: "var(--aiq-radius-pill, 9999px)",
                fontFamily: "var(--aiq-font-mono)",
                background: hits.includes(k) ? "var(--aiq-color-success-soft, #d1fae5)" : "var(--aiq-color-bg-secondary, #f3f4f6)",
                color: hits.includes(k) ? "var(--aiq-color-success, #065f46)" : "var(--aiq-color-fg-muted)",
              }}
            >
              {k}
            </span>
          ))}
          {" "}— not a score, a reading aid for the manual score below.
        </p>
      )}
    </div>
  );
}

function logAnalysisAnswer({ answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const findings = Array.isArray(a?.findings)
    ? (a!.findings as unknown[]).filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
  const explanation = typeof a?.explanation === "string" ? a.explanation : "";
  if (findings.length === 0 && explanation.trim() === "") return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {findings.length > 0 && (
        <div>
          <div style={ANSWER_SUBLABEL_STYLE}>Findings</div>
          <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
            {findings.map((f, i) => (
              <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)" }}>
                {f}
              </li>
            ))}
          </ol>
        </div>
      )}
      {explanation.trim() !== "" && (
        <div>
          <div style={ANSWER_SUBLABEL_STYLE}>Explanation</div>
          <p style={ANSWER_TEXT_STYLE}>{explanation}</p>
        </div>
      )}
    </div>
  );
}

function scenarioAnswer({ answer }: { content: unknown; answer: unknown }): React.ReactElement | null {
  const a = asAnswerObj(answer);
  const steps = Array.isArray(a?.steps) ? (a!.steps as unknown[]) : [];
  const rows = steps
    .map((s, i) => {
      const so = asAnswerObj(s);
      const resp = typeof so?.response === "string" ? so.response : "";
      const idx = typeof so?.stepIndex === "number" ? so.stepIndex : i;
      return { idx, resp };
    })
    .filter((r) => r.resp.trim() !== "");
  if (rows.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {rows.map((r, i) => (
        <div key={i}>
          <div style={ANSWER_SUBLABEL_STYLE}>Step {r.idx + 1}</div>
          <p style={ANSWER_TEXT_STYLE}>{r.resp}</p>
        </div>
      ))}
    </div>
  );
}

/** No type is null here: every registry type has an admin answer renderer. */
export const rendererMap = {
  mcq: mcqAnswer,
  subjective: subjectiveAnswer,
  kql: kqlAnswer,
  scenario: scenarioAnswer,
  log_analysis: logAnalysisAnswer,
  numeric: numericAnswer,
  multi_select: multiSelectAnswer,
  ordering: orderingAnswer,
  structured_case: structuredCaseAnswer,
} satisfies { [K in QuestionType]: QuestionRenderer | null };
