import { describe, it, expect } from "vitest";
import { GRADING_TIERS, tierOfGrading, tierOfProposal, countTiers } from "../grading-tiers.js";
import type { GradingProposal } from "../types.js";

const proposal = (over: Partial<GradingProposal>): GradingProposal => ({
  attempt_id: "a",
  question_id: "q",
  anchors: [],
  band: { reasoning_band: 0, ai_justification: "", needs_escalation: false },
  score_earned: 0,
  score_max: 1,
  prompt_version_sha: "s",
  prompt_version_label: "l",
  model: "haiku",
  escalation_chosen_stage: "2",
  generated_at: "2026-10-16T00:00:00.000Z",
  ...over,
});

describe("grading tiers", () => {
  it("fixes the tier order", () => {
    expect([...GRADING_TIERS]).toEqual(["answer_key", "reuse", "rule", "ai", "human"]);
  });

  it("tierOfGrading maps every grader", () => {
    expect(tierOfGrading({ grader: "deterministic" })).toBe("answer_key");
    expect(tierOfGrading({ grader: "pattern" })).toBe("answer_key");
    expect(tierOfGrading({ grader: "ai", model: "reuse" })).toBe("reuse");
    expect(tierOfGrading({ grader: "ai", model: "rule" })).toBe("rule");
    expect(tierOfGrading({ grader: "ai", model: "haiku-4.5+sonnet-4.6" })).toBe("ai");
    expect(tierOfGrading({ grader: "admin_override", model: "reuse" })).toBe("human");
    expect(tierOfGrading({ grader: "manual" })).toBe("human");
    expect(tierOfGrading({ grader: "ai", model: "none" })).toBe("human");
  });

  it("tierOfProposal maps source, and no source + model none to human", () => {
    expect(tierOfProposal(proposal({ source: "rule" }))).toBe("rule");
    expect(tierOfProposal(proposal({ source: "reuse" }))).toBe("reuse");
    expect(tierOfProposal(proposal({ source: "ai" }))).toBe("ai");
    expect(tierOfProposal(proposal({ model: "none", escalation_chosen_stage: "manual" }))).toBe("human");
    expect(tierOfProposal(proposal({}))).toBe("ai"); // legacy cached proposal, no source
  });

  it("countTiers counts per tier", () => {
    expect(countTiers(["ai", "ai", "human"])).toEqual({ answer_key: 0, reuse: 0, rule: 0, ai: 2, human: 1 });
  });
});
