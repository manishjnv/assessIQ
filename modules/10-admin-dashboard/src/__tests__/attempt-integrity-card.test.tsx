// FU-C8: the behaviour and integrity card shows the live counts, the radar
// (only when the released score carries signals) and the disclaimer.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class extends Error {},
}));

import { adminApi } from "../api.js";
import { AttemptIntegrityCard } from "../components/AttemptIntegrityCard.js";

const api = adminApi as unknown as ReturnType<typeof vi.fn>;

const counts = { tab_switches: 2, copy: 0, paste: 1, paste_blocked: 0, fullscreen_exits: 0, multi_tab_conflicts: 0 };
const signals = {
  time_per_question_p50_ms: 60_000,
  edit_count_total: 3,
  flag_count: 1,
  tab_blur_count: 2,
  fullscreen_exit_count: 0,
  copy_paste_count: 1,
  multi_tab_conflict_count: 0,
};

function mock(score: { archetype_signals: Record<string, number> | null } | null): void {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/integrity")) return counts;
    if (path.endsWith("/score")) return { score };
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => {
  cleanup();
  api.mockReset();
});

describe("AttemptIntegrityCard (FU-C8)", () => {
  it("shows the counts, the radar and the disclaimer when the released score has signals", async () => {
    mock({ archetype_signals: signals });
    const { container } = render(<AttemptIntegrityCard attemptId="a1" />);
    expect(await screen.findByText("Behaviour and integrity")).toBeTruthy();
    expect(screen.getByText("Left the assessment tab").nextSibling?.textContent).toBe("2");
    await waitFor(() => expect(container.querySelector('[data-test-id="attempt-behaviour-radar"]')).not.toBeNull());
    expect(screen.getByText(/not a score/i)).toBeTruthy();
    expect(screen.queryByText(/cheat/i)).toBeNull();
  });

  it("shows the counts without a radar while the result is not released (score null)", async () => {
    mock(null);
    const { container } = render(<AttemptIntegrityCard attemptId="a1" />);
    expect(await screen.findByText("Behaviour and integrity")).toBeTruthy();
    expect(container.querySelector('[data-test-id="attempt-behaviour-radar"]')).toBeNull();
  });
});
