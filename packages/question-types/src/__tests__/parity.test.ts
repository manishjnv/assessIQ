// Golden parity: the registry hooks equal the module implementations they replace.
// The only place in this package allowed to import from modules/* (test only; excluded from tsc).
import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, QUESTION_TYPE_REGISTRY, DETERMINISTIC_IDS } from "../index.js";
import { sanitizeContentForCandidate } from "../../../../modules/06-attempt-engine/src/repository.js";
import { deterministicFraction } from "../../../../modules/09-scoring/src/mcq.js";
import { coerceQuestion } from "../../../../modules/07-ai-grading/src/coerce-question-content.js";
import { coerceQuestion as mcpCoerceQuestion } from "../../../../tools/assessiq-mcp/src/tools/coerce-questions.js";
import { deriveQuestionTextForGuidance } from "../../../../modules/04-question-bank/src/answer-guidance-derive.js";
import { ANSWERS, CONTENTS, RAW } from "./fixtures.js";

describe("parity with module implementations", () => {
  it.each(QUESTION_TYPES)("%s candidateView == 06 sanitizeContentForCandidate", (t) => {
    for (const c of [...CONTENTS[t], null, "str", [1]]) {
      expect(QUESTION_TYPE_REGISTRY[t].candidateView(c)).toEqual(sanitizeContentForCandidate(t, c));
    }
  });

  it.each(DETERMINISTIC_IDS)("%s deterministicScore == 09 deterministicFraction", (t) => {
    for (const c of [...CONTENTS[t], null]) {
      for (const a of ANSWERS[t]!) {
        expect(QUESTION_TYPE_REGISTRY[t].deterministicScore!(c, a), `${t} ${JSON.stringify(c)} ${JSON.stringify(a)}`).toBe(deterministicFraction(t, c, a));
      }
    }
  });

  it.each(QUESTION_TYPES)("%s coerceContent == 07 coerceContent (via coerceQuestion) == MCP copy", (t) => {
    for (const raw of RAW[t]) {
      const expected = (coerceQuestion({ type: t, content: raw }) as { content: unknown }).content;
      expect(QUESTION_TYPE_REGISTRY[t].coerceContent(raw)).toEqual(expected);
      expect((mcpCoerceQuestion({ type: t, content: raw }) as { content: unknown }).content).toEqual(expected);
    }
  });

  it.each(QUESTION_TYPES)("%s guidanceText == 04 deriveQuestionTextForGuidance", (t) => {
    for (const c of [...CONTENTS[t], null]) {
      expect(QUESTION_TYPE_REGISTRY[t].guidanceText(c)).toBe(deriveQuestionTextForGuidance({ type: t, content: c }));
    }
  });
});
