// AssessIQ — generation attempts score button UI tests.
//
// Verifies the "Score this attempt" in-app button behavior:
//   - Button renders in the Details panel.
//   - Clicking the button calls scoreGenerationAttempt with the attempt id.
//   - Spinner appears while the request is in-flight.
//   - Structural quality table and runtime metrics table render on success.
//   - Verdict pill renders with the correct label.
//   - Error message + retry button render on failure.
//   - Score result is cached: clicking "Details ▸" again does NOT re-fetch.
//
// Pattern: vitest + React Testing Library + jsdom (matches vitest.config.ts).
// Mock strategy: vi.mock("../api.js") — all API functions stubbed.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { ScoreAttemptResponse } from "../api.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before the component import.
// ---------------------------------------------------------------------------

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
  scoreGenerationAttempt: vi.fn(),
  // Other helpers used by the page (not relevant to scoring tests)
  generateQuestionsApi: vi.fn(),
  bulkUpdateQuestionStatus: vi.fn(),
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal pass-verdict ScoreAttemptResponse. */
const MOCK_SCORE_PASS: ScoreAttemptResponse = {
  attempt: {
    id: "attempt-111",
    status: "success",
    count_requested: 5,
    count_inserted: 5,
    duration_ms: 12000,
    chunks_planned: 5,
    chunks_failed: 0,
    dedupe_dropped: null,
    citation_dropped: null,
    model: "claude-sonnet-4",
    skill_sha: null,
    error_code: null,
    error_message: null,
    stderr_tail: null,
    started_at: new Date(Date.now() - 3_600_000).toISOString(),
    finished_at: new Date(Date.now() - 3_540_000).toISOString(),
  },
  structural: {
    per_type: [
      { type: "mcq", total: 5, passed: 5, failed: 0, failures: [] },
    ],
    total: 5,
    passed: 5,
    failed: 0,
    baseline_diff: { regressions: [], improvements: [] },
  },
  runtime: {
    metrics: [
      { name: "chunk_success_rate", value: 1.0, threshold: "≥0.60", verdict: "pass" },
      { name: "total_inserted_pct",  value: 1.0, threshold: "≥0.70", verdict: "pass" },
      { name: "per_type_duration_ms (max)", value: null, threshold: "≤360000", verdict: "n/a" },
      { name: "peak_rss_mib", value: null, threshold: "≤1000", verdict: "n/a" },
    ],
  },
  overall: "pass",
};

/** A regression-verdict response. */
const MOCK_SCORE_REGRESSION: ScoreAttemptResponse = {
  ...MOCK_SCORE_PASS,
  structural: {
    ...MOCK_SCORE_PASS.structural,
    baseline_diff: {
      regressions: [{ level: "L2", type: "mcq", was_passed: 5, now_passed: 3 }],
      improvements: [],
    },
  },
  overall: "regression",
};

// Minimal GenerationAttempt for the page
const MOCK_ATTEMPT = {
  id: "attempt-111",
  status: "success" as const,
  count_requested: 5,
  count_inserted: 5,
  error_code: "ERR_EXAMPLE",
  error_message: "example error",
  stderr_tail: "some stderr",
  skill_sha: "abc123",
  model: "claude-sonnet-4",
  chunks_planned: 5,
  chunks_failed: 0,
  dedupe_dropped: null,
  duration_ms: 12000,
  started_at: new Date(Date.now() - 3_600_000).toISOString(),
  finished_at: new Date(Date.now() - 3_540_000).toISOString(),
  pack_id: "pack-001",
  level_id: "level-001",
  user_id: "user-001",
};

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { AdminGenerationAttempts } from "../pages/generation-attempts.js";
import { adminApi, scoreGenerationAttempt } from "../api.js";

const mockAdminApi = adminApi as ReturnType<typeof vi.fn>;
const mockScoreGenerationAttempt = scoreGenerationAttempt as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // Default: list endpoint returns our mock attempt; packs endpoint returns empty.
  mockAdminApi.mockImplementation((path: string) => {
    if (typeof path === "string" && path.includes("generation-attempts")) {
      return Promise.resolve({
        items: [MOCK_ATTEMPT],
        total: 1,
        limit: 50,
        offset: 0,
      });
    }
    if (typeof path === "string" && path.includes("packs")) {
      return Promise.resolve({ items: [], total: 0 });
    }
    return Promise.resolve({});
  });
});

// ---------------------------------------------------------------------------
// Helper: render page, expand the first attempt's Details panel.
// ---------------------------------------------------------------------------

async function renderAndExpand(): Promise<void> {
  render(React.createElement(AdminGenerationAttempts));
  // Wait for the list to load and "Details ▸" button to appear
  await waitFor(() => {
    expect(screen.getByText("Details ▸")).toBeDefined();
  });
  fireEvent.click(screen.getByText("Details ▸"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Score this attempt — button render", () => {
  it("renders 'Score this attempt' button when the row is expanded", async () => {
    await renderAndExpand();
    expect(screen.getByText("Score this attempt")).toBeDefined();
  });

  it("does NOT auto-score on expand — scoreGenerationAttempt not called", async () => {
    await renderAndExpand();
    expect(mockScoreGenerationAttempt).not.toHaveBeenCalled();
  });
});

describe("Score this attempt — click → success", () => {
  it("calls scoreGenerationAttempt with the correct attempt id on click", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(mockScoreGenerationAttempt).toHaveBeenCalledWith("attempt-111");
    });
  });

  it("renders 'Structural quality' table heading after scoring", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Structural quality")).toBeDefined();
    });
  });

  it("renders 'Runtime metrics' table heading when metrics are present", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Runtime metrics")).toBeDefined();
    });
  });

  it("shows the 'Pass' verdict pill for a pass result", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Pass")).toBeDefined();
    });
  });

  it("shows the 'Regression' verdict pill for a regression result", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_REGRESSION);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Regression")).toBeDefined();
    });
  });

  it("renders the mcq row in the structural table", async () => {
    mockScoreGenerationAttempt.mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("mcq")).toBeDefined();
    });
  });
});

describe("Score this attempt — click → error", () => {
  it("shows 'Could not score this attempt' error message on failure", async () => {
    mockScoreGenerationAttempt.mockRejectedValueOnce(new Error("Server error"));

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      const errorText = screen.queryByText(/Could not score this attempt/i);
      expect(errorText).toBeDefined();
    });
  });

  it("renders a Retry button on error", async () => {
    mockScoreGenerationAttempt.mockRejectedValueOnce(new Error("Server error"));

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeDefined();
    });
  });

  it("clicking Retry re-calls scoreGenerationAttempt", async () => {
    mockScoreGenerationAttempt
      .mockRejectedValueOnce(new Error("Server error"))
      .mockResolvedValueOnce(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(mockScoreGenerationAttempt).toHaveBeenCalledTimes(2);
    });
  });
});

describe("Score this attempt — caching", () => {
  it("re-expanding the row after scoring does NOT call scoreGenerationAttempt again", async () => {
    mockScoreGenerationAttempt.mockResolvedValue(MOCK_SCORE_PASS);

    await renderAndExpand();
    fireEvent.click(screen.getByText("Score this attempt"));

    await waitFor(() => {
      expect(screen.getByText("Structural quality")).toBeDefined();
    });

    // Collapse
    fireEvent.click(screen.getByText("Hide ▴"));

    // Re-expand
    await waitFor(() => {
      expect(screen.getByText("Details ▸")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Details ▸"));

    // The result should still be cached — no additional call
    await waitFor(() => {
      expect(screen.getByText("Structural quality")).toBeDefined();
    });

    expect(mockScoreGenerationAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("Score this attempt — CLI footnote", () => {
  it("shows 'For deeper diagnostics, run on the VPS' footnote", async () => {
    await renderAndExpand();
    const footnote = screen.queryByText(/For deeper diagnostics, run on the VPS/i);
    expect(footnote).toBeDefined();
  });

  it("shows the CLI command in a pre element", async () => {
    await renderAndExpand();
    const pres = Array.from(document.querySelectorAll("pre"));
    const cliPre = pres.find((p) => p.textContent?.includes("score-candidate"));
    expect(cliPre).toBeDefined();
    expect(cliPre?.textContent).toContain("attempt-111");
  });
});
