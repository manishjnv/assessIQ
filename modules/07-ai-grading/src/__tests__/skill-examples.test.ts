/**
 * E3 (Z-164): every example payload printed in the grading skills must pass the parser the runtime uses.
 *
 * Why: the grade-anchors example shows "evidence_quote": null for a miss. The schema took only a string, so
 * Haiku copied the example, the parse failed and Stage 1 fell back to "reasoning only" in 17 of 27 eval cases
 * (fixed in 64106398). The skill files live on the VPS only, so the examples are copied here as fixtures.
 * When a skill example changes, change the fixture too; a failing test here means the parser and the skill disagree.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { coerceSubmitAnchorsPayload } from "../runtimes/claude-code-vps.js";
import { AnchorFindingSchema, BandFindingSchema } from "../types.js";

const SubmitAnchorsInputSchema = z.object({ findings: z.array(AnchorFindingSchema) });

// grade-anchors "Output contract" example (a hit with a quote, a miss with evidence_quote: null)
const ANCHORS_EXAMPLE = {
  findings: [
    { anchor_id: "a1", hit: true, evidence_quote: "saw lateral movement from the user's host into the file server", confidence: 0.85 },
    { anchor_id: "a2", hit: false, evidence_quote: null, confidence: 0.95 },
  ],
};

// grade-band example
const BAND_EXAMPLE = {
  reasoning_band: 3,
  ai_justification: "Identified lateral movement and credential reuse correctly. Minor gap: no identity pivot.",
  error_class: "missed_pivot_to_identity",
  needs_escalation: false,
};

// grade-escalate example (error_class: null)
const ESCALATE_EXAMPLE = {
  reasoning_band: 3,
  ai_justification: "On balance, band 3. Strongest case for band 4 ... strongest case for band 2 ...",
  error_class: null,
  needs_escalation: false,
};

describe("skill example payloads parse", () => {
  it("grade-anchors example parses through the runtime coercion", () => {
    expect(SubmitAnchorsInputSchema.safeParse(coerceSubmitAnchorsPayload(ANCHORS_EXAMPLE)).success).toBe(true);
  });

  it("grade-anchors example keeps the hit and the quote after coercion", () => {
    const out = SubmitAnchorsInputSchema.parse(coerceSubmitAnchorsPayload(ANCHORS_EXAMPLE));
    expect(out.findings[0]?.evidence_quote).toContain("lateral movement");
    expect(out.findings[1]?.hit).toBe(false);
  });

  it("the old bare schema rejects the anchors example (the 17-of-27 bug): the test is able to fail", () => {
    expect(SubmitAnchorsInputSchema.safeParse(ANCHORS_EXAMPLE).success).toBe(false);
  });

  it("grade-band example parses", () => {
    expect(BandFindingSchema.safeParse(BAND_EXAMPLE).success).toBe(true);
  });

  it("grade-escalate example parses (error_class: null)", () => {
    expect(BandFindingSchema.safeParse(ESCALATE_EXAMPLE).success).toBe(true);
  });
});
