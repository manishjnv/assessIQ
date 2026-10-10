import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, getQuestionType } from "@assessiq/question-types";

describe("GenerableQuestionType", () => {
  it("matches the registry ids whose generatorSkill is non-null", () => {
    const generable = QUESTION_TYPES.filter((t) => getQuestionType(t).generatorSkill !== null).sort();
    expect(generable).toEqual(["kql", "log_analysis", "mcq", "scenario", "subjective"]);
  });
});
