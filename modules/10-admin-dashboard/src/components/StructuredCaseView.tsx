// AssessIQ — admin rendering of a `structured_case` question (log/narrative + choice steps).
// One component for every admin zone; the answer key is shown ONLY in "key" and "answer" modes
// (admin-only views). Never renders raw JSON except via the shared <JsonFallback>.
//
//   prompt  title, context, log, steps with plain option lists (what the candidate saw)
//   key     steps with the correct options marked, scoring note, explanation
//   answer  the candidate's picks per step, marked right / wrong against the key

import React from "react";
import { cleanText, safeStr, safeArr, obj, JsonFallback, SUBLABEL_STYLE, OPTION_LABELS } from "./question-format.js";

type Mode = "prompt" | "key" | "answer";

interface Step {
  id: string;
  prompt: string;
  select: string;
  options: string[];
  correct: number[];
}

function stepsOf(c: Record<string, unknown>): Step[] {
  return (safeArr<unknown>(c.steps) ?? []).flatMap((s) => {
    const o = obj(s);
    if (o === null) return [];
    const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
    return [{
      id: safeStr(o.id) ?? "",
      prompt: safeStr(o.prompt) ?? "",
      select: safeStr(o.select) ?? "one",
      options: (safeArr<unknown>(o.options) ?? []).map((x) => (typeof x === "string" ? x : "")),
      correct: ints(o.correct),
    }];
  });
}

const OK = "var(--aiq-color-success, #065f46)";
const BAD = "var(--aiq-color-danger)";

export function StructuredCaseView({
  c,
  mode,
  withCase = true,
  answer,
}: {
  c: Record<string, unknown>;
  mode: Mode;
  /** Show title, context and log above the steps. */
  withCase?: boolean;
  answer?: unknown;
}): React.ReactElement {
  const title = safeStr(c.title);
  const context = safeStr(c.context);
  const log = safeStr(c.log_excerpt);
  const expl = safeStr(c.explanation);
  const steps = stepsOf(c);
  const picks = obj(obj(answer)?.steps) ?? {};
  const text: React.CSSProperties = { margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.6, whiteSpace: "pre-wrap" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {withCase && title != null && <div style={{ ...text, fontWeight: 600, fontSize: "var(--aiq-text-md)" }}>{cleanText(title)}</div>}
      {withCase && context != null && <p style={text}>{cleanText(context)}</p>}
      {withCase && log != null && (
        <pre
          style={{
            margin: 0,
            padding: "var(--aiq-space-sm)",
            background: "var(--aiq-color-bg-secondary, #f8f8f8)",
            borderRadius: 4,
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            whiteSpace: "pre-wrap",
            overflowX: "auto",
            color: "var(--aiq-color-fg-primary)",
            border: "1px solid var(--aiq-color-border, #e5e7eb)",
          }}
        >
          {log}
        </pre>
      )}
      {mode === "key" && (
        <span style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          Structured case · scoring: {c.scoring === "all_or_nothing" ? "all or nothing" : "partial credit"}
        </span>
      )}
      {steps.map((s, n) => {
        const chosen = Array.isArray(picks[s.id]) ? (picks[s.id] as unknown[]).filter((x): x is number => typeof x === "number") : [];
        return (
          <div key={s.id || n}>
            <div style={SUBLABEL_STYLE}>
              Step {n + 1} · {s.select === "many" ? "select all that apply" : "select one"}
            </div>
            <p style={text}>{cleanText(s.prompt)}</p>
            <ul style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", listStyle: "none" }}>
              {s.options.map((o, i) => {
                const right = s.correct.includes(i);
                const picked = chosen.includes(i);
                let mark = "";
                let color = "var(--aiq-color-fg-secondary)";
                if (mode === "key" && right) { mark = " ✓"; color = OK; }
                if (mode === "answer") {
                  if (picked) { mark = right ? " ✓ (selected)" : " ✗ (selected)"; color = right ? OK : BAD; }
                  else if (right) { mark = " (correct, not selected)"; color = "var(--aiq-color-fg-muted)"; }
                }
                return (
                  <li key={i} style={{ ...text, color, fontWeight: mark !== "" ? 600 : 400 }}>
                    <span style={{ fontFamily: "var(--aiq-font-mono)", marginRight: "var(--aiq-space-sm)" }}>{OPTION_LABELS[i] ?? i}</span>
                    {cleanText(o)}{mark}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {steps.length === 0 && <JsonFallback value={c.steps} />}
      {mode === "key" && expl != null && (
        <div>
          <div style={SUBLABEL_STYLE}>Explanation</div>
          <p style={text}>{cleanText(expl)}</p>
        </div>
      )}
      {mode === "prompt" && (
        <span style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          Candidates answer each step. Options are shown in this order.
        </span>
      )}
    </div>
  );
}
