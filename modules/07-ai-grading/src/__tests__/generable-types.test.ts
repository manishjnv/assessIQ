import { describe, expect, it } from "vitest";
import { DETERMINISTIC_IDS, QUESTION_TYPES, getQuestionType } from "@assessiq/question-types";
import { GENERABLE_IDS } from "../types.js";
import { EVAL_STRUCTURAL_TYPES } from "../../eval/runner.js";

describe("GenerableQuestionType", () => {
  it("matches the registry ids whose generatorSkill is non-null", () => {
    const generable = QUESTION_TYPES.filter((t) => getQuestionType(t).generatorSkill !== null).sort();
    expect(generable).toEqual(["kql", "log_analysis", "mcq", "scenario", "subjective"]);
  });

  it("GENERABLE_IDS and EVAL_STRUCTURAL_TYPES are the five generator-skill types", () => {
    expect([...GENERABLE_IDS].sort()).toEqual(["kql", "log_analysis", "mcq", "scenario", "subjective"]);
    expect([...EVAL_STRUCTURAL_TYPES].sort()).toEqual([...GENERABLE_IDS].sort());
  });

  it("DETERMINISTIC_IDS (queue SQL non_mcq filter) is the five non-AI, non-kql types", () => {
    expect([...DETERMINISTIC_IDS].sort()).toEqual(["mcq", "multi_select", "numeric", "ordering", "structured_case"]);
  });
});
