import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const load = vi.fn();
vi.mock("../api.js", () => ({ getSuperQuestionStats: (...a: unknown[]) => load(...a) }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { QuestionStatsCard } from "../components/QuestionStatsCard.js";

afterEach(() => { cleanup(); load.mockReset(); });

const gradient = [
  { level_position: 1, label: "L1", mean_success: 0.4, attempts: 40 },
  { level_position: 2, label: "L2", mean_success: 0.9, attempts: 40 },
  { level_position: 3, label: "L3", mean_success: 0.5, attempts: 40 },
];

describe("QuestionStatsCard", () => {
  it("shows a note and no table when there is no volume", async () => {
    load.mockResolvedValue({ question: { level_position: 1 }, stats: null, gradient: [], miscalibrated: { flag: false, reason: null, min_attempts: 30 }, scope: "rollup", clone_count: 2 });
    render(<QuestionStatsCard questionId="q1" />);
    await waitFor(() => expect(screen.getByText(/No graded attempts on this question yet/)).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/Across 2 copies of this platform question/)).toBeTruthy();
  });

  it("shows the Noise and Miscalibrated chips and the sample-size note", async () => {
    load.mockResolvedValue({
      question: { level_position: 2 },
      stats: { attempts: 12, exposure_count: 15, correct_rate: 0.9, mean_band: null, point_biserial: 0.05, discrimination_ok: false, last_used_at: null, computed_at: "2026-10-17T00:00:00Z" },
      gradient,
      miscalibrated: { flag: true, reason: "This level scores higher than the level below it. The level order is inverted.", min_attempts: 30 },
    });
    render(<QuestionStatsCard questionId="q1" />);
    await waitFor(() => expect(screen.getByText("Noise")).toBeTruthy());
    expect(screen.getByText("Miscalibrated")).toBeTruthy();
    expect(screen.getByText(/level order is inverted/)).toBeTruthy();
    expect(screen.getByText(/Phase C needs 30\+ attempts/)).toBeTruthy();
    expect(screen.getByText(/L2 \(this question\)/)).toBeTruthy();
  });
});
