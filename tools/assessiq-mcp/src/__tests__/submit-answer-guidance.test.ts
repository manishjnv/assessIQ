/**
 * Unit tests for ../tools/submit-answer-guidance.ts
 *
 * Covers: happy path (valid hint echoed as JSON), empty rejection, over-length
 * rejection (>280), and extra-key rejection (.strict()).
 *
 * Run: node --import tsx/esm --test src/__tests__/submit-answer-guidance.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleSubmitAnswerGuidance } from "../tools/submit-answer-guidance.js";

describe("submit_answer_guidance", () => {
  it("accepts a valid hint and echoes it as JSON", () => {
    const res = handleSubmitAnswerGuidance({
      answer_guidance: "Write a focused answer — about 3–6 sentences.",
    });
    const text = res.content[0]?.text ?? "";
    assert.ok(!text.startsWith("validation_error"), "should not be a validation error");
    const parsed = JSON.parse(text) as { answer_guidance: string };
    assert.equal(parsed.answer_guidance, "Write a focused answer — about 3–6 sentences.");
  });

  it("rejects an empty hint", () => {
    const res = handleSubmitAnswerGuidance({ answer_guidance: "" });
    assert.match(res.content[0]?.text ?? "", /validation_error/);
  });

  it("rejects a hint longer than 280 chars", () => {
    const res = handleSubmitAnswerGuidance({ answer_guidance: "x".repeat(281) });
    assert.match(res.content[0]?.text ?? "", /validation_error/);
  });

  it("rejects a missing field", () => {
    const res = handleSubmitAnswerGuidance({});
    assert.match(res.content[0]?.text ?? "", /validation_error/);
  });

  it("rejects extra keys (.strict)", () => {
    const res = handleSubmitAnswerGuidance({
      answer_guidance: "Select the one best option.",
      leaked_answer: "option B",
    });
    assert.match(res.content[0]?.text ?? "", /validation_error/);
  });
});
