/**
 * structured_case: the candidate view carries title/context/log_excerpt and, per step, only
 * id/prompt/select/options (never correct / scoring / explanation); the save-time shape check is
 * keyed on the question type and validates step ids and indexes against the frozen content. Pure.
 */
import { describe, it, expect } from "vitest";
import { sanitizeContentForCandidate } from "../repository.js";
import { checkAnswerForSave } from "../types.js";
import { answerGuidanceFor } from "../answer-guidance.js";

const content = {
  title: "Suspicious logons",
  context: "Review the log.",
  log_excerpt: "10:01 failed logon admin",
  steps: [
    { id: "s1", prompt: "Which lines?", select: "many", options: ["a", "b", "c"], correct: [0, 1] },
    { id: "s2", prompt: "Next?", select: "one", options: ["Block", "Ignore"], correct: [0] },
  ],
  scoring: "partial",
  explanation: "SECRET-WHY",
};

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("structured_case sanitizer", () => {
  it("keeps title, context, log_excerpt and per-step id/prompt/select/options only", () => {
    expect(sanitizeContentForCandidate("structured_case", content)).toEqual({
      title: content.title,
      context: content.context,
      log_excerpt: content.log_excerpt,
      steps: content.steps.map(({ id, prompt, select, options }) => ({ id, prompt, select, options })),
    });
  });

  it("no key named correct / scoring / explanation anywhere in the output", () => {
    const out = sanitizeContentForCandidate("structured_case", content);
    const keys = keysDeep(out);
    for (const k of ["correct", "scoring", "explanation"]) expect(keys).not.toContain(k);
    expect(JSON.stringify(out)).not.toMatch(/SECRET-WHY/);
  });

  it("malformed steps degrade to an empty list and never leak", () => {
    expect(sanitizeContentForCandidate("structured_case", { ...content, steps: "x" })).toMatchObject({ steps: [] });
    const out = sanitizeContentForCandidate("structured_case", { ...content, steps: [{ id: "s", correct: [0] }, 5] });
    expect(keysDeep(out)).not.toContain("correct");
  });

  it("has an answer-guidance default", () => {
    expect(answerGuidanceFor("structured_case", null)).toBe("Read the case, then answer each step.");
  });
});

describe("checkAnswerForSave structured_case", () => {
  const ok = { steps: { s1: [0, 2], s2: [1] } };

  it("accepts the canonical shape and strips unknown top-level keys", () => {
    expect(checkAnswerForSave("structured_case", { ...ok, junk: 1 }, content)).toEqual({ ok: true, answer: ok });
    expect(checkAnswerForSave("structured_case", { steps: {} }, content)).toEqual({ ok: true, answer: { steps: {} } });
  });

  it("null means no answer", () => {
    expect(checkAnswerForSave("structured_case", null, content)).toEqual({ ok: true, answer: null });
  });

  it("rejects unknown step ids, non-integer, negative, out-of-range and duplicate values", () => {
    for (const bad of [
      { steps: { ghost: [0] } },
      { steps: { s1: [0.5] } },
      { steps: { s1: [-1] } },
      { steps: { s1: [3] } },
      { steps: { s2: [2] } },
      { steps: { s1: [1, 1] } },
      { steps: { s1: "a" } },
      { steps: [] },
      { steps: null },
      "text",
      3,
      [],
      {},
    ]) {
      expect(checkAnswerForSave("structured_case", bad, content), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });

  it("fails closed when the frozen content is missing", () => {
    expect(checkAnswerForSave("structured_case", ok)).toEqual({ ok: false });
    expect(checkAnswerForSave("structured_case", ok, null)).toEqual({ ok: false });
  });

  it("is keyed on the question type: other types are stored as sent", () => {
    for (const t of ["mcq", "subjective", "ordering", null]) {
      expect(checkAnswerForSave(t, { steps: { ghost: [99] } }, content)).toEqual({ ok: true, answer: { steps: { ghost: [99] } } });
    }
  });
});
