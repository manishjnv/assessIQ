// AssessIQ — authoring form for a `structured_case` question (log/narrative + choice steps).
// Create-form only, like the ordering editor. Uses the same plain primitives as the other
// editors (aiq-input / aiq-btn / HelpTip). The correct marks are the answer key (admin only).

import React from "react";
import { HelpTip } from "@assessiq/help-system/components";

export interface ScStep {
  prompt: string;
  select: "one" | "many";
  options: string[];
  correct: number[];
}

export interface ScState {
  title: string;
  context: string;
  log: string;
  steps: ScStep[];
  scoring: "all_or_nothing" | "partial";
  explanation: string;
}

export const newScStep = (): ScStep => ({ prompt: "", select: "one", options: ["", ""], correct: [0] });

export const EMPTY_SC: ScState = {
  title: "",
  context: "",
  log: "",
  steps: [newScStep()],
  scoring: "partial",
  explanation: "",
};

/** Form value -> question content. Step ids are s1, s2, ... by position (create-only form). */
export function buildStructuredCaseContent(s: ScState): unknown {
  return {
    title: s.title.trim(),
    context: s.context.trim(),
    ...(s.log.trim() ? { log_excerpt: s.log.trim() } : {}),
    steps: s.steps.map((st, i) => ({
      id: `s${i + 1}`,
      prompt: st.prompt.trim(),
      select: st.select,
      options: st.options.map((o) => o.trim()),
      correct: [...st.correct].sort((a, b) => a - b),
    })),
    scoring: s.scoring,
    ...(s.explanation.trim() ? { explanation: s.explanation.trim() } : {}),
  };
}

/** First problem with the form, or null when it can be saved. */
export function structuredCaseError(s: ScState): string | null {
  if (!s.title.trim() || !s.context.trim()) return "Structured case needs a title and a context.";
  if (s.steps.length < 1 || s.steps.length > 12) return "Structured case needs 1 to 12 steps.";
  for (const [i, st] of s.steps.entries()) {
    if (!st.prompt.trim()) return `Step ${i + 1} needs a prompt.`;
    if (st.options.length < 2 || st.options.length > 8 || st.options.some((o) => !o.trim())) return `Step ${i + 1} needs 2 to 8 options, none blank.`;
    if (st.correct.length < 1) return `Step ${i + 1} needs at least one correct option.`;
    if (st.select === "one" && st.correct.length !== 1) return `Step ${i + 1} (select one) needs exactly one correct option.`;
  }
  return null;
}

export function StructuredCaseEditor({ value, onChange }: { value: ScState; onChange: (v: ScState) => void }): React.ReactElement {
  const set = (patch: Partial<ScState>): void => onChange({ ...value, ...patch });
  const setStep = (i: number, patch: Partial<ScStep>): void =>
    set({ steps: value.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const removeOption = (i: number, o: number): void => {
    const st = value.steps[i] as ScStep;
    setStep(i, {
      options: st.options.filter((_, k) => k !== o),
      correct: st.correct.filter((c) => c !== o).map((c) => (c > o ? c - 1 : c)),
    });
  };
  const toggleCorrect = (i: number, o: number): void => {
    const st = value.steps[i] as ScStep;
    if (st.select === "one") setStep(i, { correct: [o] });
    else setStep(i, { correct: st.correct.includes(o) ? st.correct.filter((c) => c !== o) : [...st.correct, o] });
  };
  const changeSelect = (i: number, select: "one" | "many"): void => {
    const st = value.steps[i] as ScStep;
    setStep(i, { select, correct: select === "one" ? [st.correct[0] ?? 0] : st.correct });
  };

  return (
    <div className="aiq-form-group" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <HelpTip helpId="admin.question.editor.content.structured_case">
        <label className="aiq-label" htmlFor="q-sc-title">Title *</label>
      </HelpTip>
      <input id="q-sc-title" className="aiq-input" type="text" value={value.title} onChange={(e) => set({ title: e.target.value })} />
      <label className="aiq-label" htmlFor="q-sc-context">Context (the narrative the candidate reads) *</label>
      <textarea id="q-sc-context" className="aiq-input" style={{ minHeight: 100, resize: "vertical" }} value={value.context} onChange={(e) => set({ context: e.target.value })} />
      <label className="aiq-label" htmlFor="q-sc-log">Log excerpt (optional, up to 20000 characters)</label>
      <textarea
        id="q-sc-log"
        className="aiq-input"
        style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", minHeight: 120, resize: "vertical" }}
        value={value.log}
        maxLength={20000}
        spellCheck={false}
        onChange={(e) => set({ log: e.target.value })}
      />

      <HelpTip helpId="admin.question.editor.structured_case.steps">
        <span className="aiq-label">Steps (1 to 12) *</span>
      </HelpTip>
      {value.steps.map((st, i) => (
        <fieldset key={i} style={{ border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", padding: "var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <legend style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>Step {i + 1}</legend>
          <input className="aiq-input" type="text" aria-label={`Step ${i + 1} prompt`} placeholder="Prompt" value={st.prompt} onChange={(e) => setStep(i, { prompt: e.target.value })} />
          <select className="aiq-input" aria-label={`Step ${i + 1} answer type`} value={st.select} onChange={(e) => changeSelect(i, e.target.value as "one" | "many")}>
            <option value="one">Select one (radio)</option>
            <option value="many">Select many (checkboxes)</option>
          </select>
          {st.options.map((text, o) => (
            <div key={o} style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
              <input
                type={st.select === "one" ? "radio" : "checkbox"}
                name={`sc-correct-${i}`}
                aria-label={`Step ${i + 1} option ${o + 1} is correct`}
                checked={st.correct.includes(o)}
                onChange={() => toggleCorrect(i, o)}
              />
              <input
                className="aiq-input"
                type="text"
                aria-label={`Step ${i + 1} option ${o + 1}`}
                value={text}
                onChange={(e) => setStep(i, { options: st.options.map((s, k) => (k === o ? e.target.value : s)) })}
                style={{ flex: 1 }}
              />
              <button type="button" className="aiq-btn aiq-btn-ghost" aria-label={`Remove step ${i + 1} option ${o + 1}`} disabled={st.options.length <= 2} onClick={() => removeOption(i, o)}>Remove</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
            <button type="button" className="aiq-btn aiq-btn-ghost" disabled={st.options.length >= 8} onClick={() => setStep(i, { options: [...st.options, ""] })}>Add option</button>
            <button type="button" className="aiq-btn aiq-btn-ghost" aria-label={`Remove step ${i + 1}`} disabled={value.steps.length <= 1} onClick={() => set({ steps: value.steps.filter((_, k) => k !== i) })}>Remove step</button>
          </div>
        </fieldset>
      ))}
      <div>
        <button type="button" className="aiq-btn aiq-btn-ghost" disabled={value.steps.length >= 12} onClick={() => set({ steps: [...value.steps, newScStep()] })}>Add step</button>
      </div>

      <HelpTip helpId="admin.question.editor.structured_case.scoring">
        <label className="aiq-label" htmlFor="q-sc-scoring">Scoring</label>
      </HelpTip>
      <select id="q-sc-scoring" className="aiq-input" value={value.scoring} onChange={(e) => set({ scoring: e.target.value as "all_or_nothing" | "partial" })}>
        <option value="partial">Partial credit (average of the steps)</option>
        <option value="all_or_nothing">All or nothing (every step right)</option>
      </select>
      <label className="aiq-label" htmlFor="q-sc-expl">Explanation (optional, never shown to the candidate)</label>
      <textarea id="q-sc-expl" className="aiq-input" style={{ minHeight: 60, resize: "vertical" }} value={value.explanation} onChange={(e) => set({ explanation: e.target.value })} />
    </div>
  );
}
