import { describe, expect, it } from "vitest";
import * as L from "../labels.js";

describe("labels glossary", () => {
  it("uses glossary words for result state", () => {
    expect(L.evaluationStatusDisplay("awaiting_evaluation").label).toBe("Awaiting grading");
    expect(L.evaluationStatusDisplay("ready_to_publish").label).toBe("Ready to release");
    expect(L.evaluationStatusDisplay("published").label).toBe("Released");
  });

  it("maps known values", () => {
    expect(L.attemptStatusDisplay("pending_admin_grading").label).toBe("Pending grading");
    expect(L.packStatusDisplay("archived").label).toBe("Archived");
    expect(L.assessmentStatusDisplay("active").label).toBe("Active");
    expect(L.organisationStatusDisplay("suspended").label).toBe("Suspended");
    expect(L.questionTypeLabel("mcq")).toBe("Multiple choice");
    expect(L.questionTypeLabel("log_analysis")).toBe("Log analysis");
    expect(L.questionTypeLabel("structured_case")).toBe("Structured case");
    expect(L.planTierLabel("pro")).toBe("Pro");
    expect(L.certificateTierLabel("honors")).toBe("Honours");
    expect(L.audienceLabel("all")).toBe("Everyone");
    expect(L.roleLabel("super_admin")).toBe("Platform admin");
    expect(L.roleLabel("candidate")).toBe("Candidate");
    expect(L.jobStatusLabel("active")).toBe("Running");
    expect(L.generationStatusLabel("partial")).toBe("Partial");
    expect(L.cognitiveLevelLabel("analyze")).toBe("Analyse");
    expect(L.grantScopeLabel("domain")).toBe("Subject");
    expect(L.grantScopeLabel("pack")).toBe("Question set");
    expect(L.difficultyLabel("L1")).toBe("Beginner");
    expect(L.difficultyLabel("2")).toBe("Intermediate");
    expect(L.difficultyLabel("L3")).toBe("Advanced");
    expect(L.questionStatusLabel("draft")).toBe("Draft");
  });

  it("falls back to a humanized label for unknown values", () => {
    expect(L.attemptStatusDisplay("some_new_state")).toEqual({ label: "Some new state", variant: "default" });
    expect(L.packStatusDisplay("weird-one").label).toBe("Weird one");
    for (const fn of [L.questionTypeLabel, L.planTierLabel, L.roleLabel, L.audienceLabel, L.jobStatusLabel, L.grantScopeLabel]) {
      expect(fn("brand_new")).toBe("Brand new");
    }
    expect(L.difficultyLabel("SOC Analyst L1")).toBe("SOC Analyst L1");
    expect(L.roleLabel(null)).toBe("");
  });
});
