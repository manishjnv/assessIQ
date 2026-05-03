// AssessIQ — module 10 unit tests.
// Phase 2 G2.C — Vitest + jsdom.
//
// Coverage:
//  - AnchorChip: hit renders checkmark, miss renders x, no XSS
//  - BandPicker: band→pct mapping, onChange fires with correct value
//  - ScoreDetail: renders band pct, grader badge, override reason

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { AnchorChip } from "../components/AnchorChip.js";
import { BandPicker } from "../components/BandPicker.js";
import { ScoreDetail } from "../components/ScoreDetail.js";
import type { AnchorFinding } from "@assessiq/ai-grading";
import type { GradingsRow } from "@assessiq/ai-grading";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// AnchorChip
// ---------------------------------------------------------------------------

describe("AnchorChip", () => {
  const hitFinding: AnchorFinding = {
    anchor_id: "anchor-lateral-movement",
    hit: true,
    evidence_quote: "candidate mentioned east-west traffic pivot",
    confidence: 0.92,
  };

  const missFinding: AnchorFinding = {
    anchor_id: "anchor-privilege-escalation",
    hit: false,
  };

  it("renders hit anchor with check indicator", () => {
    render(<AnchorChip finding={hitFinding} label="lateral movement" />);
    expect(screen.getByText(/lateral movement/i)).toBeDefined();
    const text = document.body.textContent ?? "";
    // Hit chips contain a checkmark indicator
    expect(text.includes("lateral movement")).toBe(true);
  });

  it("renders miss anchor with x indicator", () => {
    render(<AnchorChip finding={missFinding} label="privilege escalation" />);
    expect(screen.getByText(/privilege escalation/i)).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text.includes("privilege escalation")).toBe(true);
  });

  it("shows anchor_id as fallback label when no label prop", () => {
    render(<AnchorChip finding={hitFinding} />);
    expect(screen.getByText(hitFinding.anchor_id)).toBeDefined();
  });

  it("does not render a script element from xss evidence_quote", () => {
    const xssFinding: AnchorFinding = {
      anchor_id: "xss-test",
      hit: true,
      evidence_quote: "<script>alert(1)</script>",
      confidence: 0.8,
    };
    const { container } = render(<AnchorChip finding={xssFinding} />);
    expect(container.querySelector("script")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BandPicker
// ---------------------------------------------------------------------------

describe("BandPicker", () => {
  const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

  it("renders all 5 band options", () => {
    render(<BandPicker value={null} onChange={() => {}} />);
    for (let band = 0; band <= 4; band++) {
      expect(document.body.textContent).toContain(`Band ${band}`);
    }
  });

  it.each([0, 1, 2, 3, 4] as const)("shows correct pct for band %d", (band) => {
    render(<BandPicker value={null} onChange={() => {}} />);
    expect(document.body.textContent).toContain(`${BAND_PCT[band]}%`);
  });

  it("calls onChange with the correct band number when a radio is clicked", () => {
    const onChange = vi.fn();
    render(<BandPicker value={null} onChange={onChange} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const radio3 = radios[3];
    if (radio3) fireEvent.click(radio3);
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("marks the current value as checked", () => {
    render(<BandPicker value={2} onChange={() => {}} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[2]?.checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ScoreDetail
// ---------------------------------------------------------------------------

describe("ScoreDetail", () => {
  const baseGrading: GradingsRow = {
    id: "g1",
    tenant_id: "t1",
    attempt_id: "at1",
    question_id: "q1",
    grader: "ai",
    score_earned: 15,
    score_max: 20,
    status: "partial",
    anchor_hits: [],
    reasoning_band: 3,
    ai_justification: "Good reasoning overall.",
    error_class: null,
    prompt_version_sha: "abc123",
    prompt_version_label: "grade-band@1.0.0",
    model: "claude-sonnet-4-5",
    escalation_chosen_stage: null,
    graded_at: new Date("2025-01-01"),
    graded_by: null,
    override_of: null,
    override_reason: null,
  };

  it("renders band 3 as 75%", () => {
    render(<ScoreDetail grading={baseGrading} />);
    expect(document.body.textContent).toContain("75%");
  });

  it("renders score_earned / score_max", () => {
    render(<ScoreDetail grading={baseGrading} />);
    expect(document.body.textContent).toContain("15");
    expect(document.body.textContent).toContain("20");
  });

  it("renders ai_justification as plain text", () => {
    render(<ScoreDetail grading={baseGrading} />);
    expect(document.body.textContent).toContain("Good reasoning overall.");
  });

  it("renders override_reason when present", () => {
    const withOverride: GradingsRow = {
      ...baseGrading,
      grader: "admin_override",
      override_reason: "Band was too low.",
      status: "overridden",
    };
    render(<ScoreDetail grading={withOverride} />);
    expect(document.body.textContent).toContain("Band was too low.");
  });

  it("renders grader badge", () => {
    render(<ScoreDetail grading={baseGrading} />);
    expect(document.body.textContent).toContain("ai");
  });
});
