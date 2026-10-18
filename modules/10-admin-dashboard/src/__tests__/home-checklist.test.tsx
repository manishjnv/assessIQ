// Z-24 — "Run an assessment" checklist on the admin Home.
// Happy path: ticks come from mocked live counts. Failure: a safe fallback, no crash.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { adminApi, AdminApiError } from "../api.js";
import { RunAssessmentChecklist } from "../components/RunAssessmentChecklist.js";
import {
  buildChecklistSteps,
  allStepsDone,
  stepHref,
  safeCount,
} from "../lib/checklist.js";

const mockApi = adminApi as unknown as ReturnType<typeof vi.fn>;
const ASSESSMENT_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

interface Scenario {
  items: unknown[];
  invitations: { total: number; viewed: number; started: number; submitted: number };
  all: number;
  awaiting: number;
  gradedOrLater: number;
  released: number;
}

function mockScenario(s: Scenario): void {
  mockApi.mockImplementation((url: string) => {
    if (url.startsWith("/admin/assessments")) return Promise.resolve({ items: s.items, total: s.items.length });
    if (url.startsWith("/admin/attempts")) {
      const status = new URLSearchParams(url.split("?")[1] ?? "").get("status");
      let total = s.all;
      if (status === "released") total = s.released;
      else if (status === "graded,released") total = s.gradedOrLater;
      else if (status !== null) total = s.awaiting;
      return Promise.resolve({ items: [], total });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

const assessmentRow = (invitations: Scenario["invitations"]) => ({
  id: ASSESSMENT_ID,
  name: "SOC L1",
  invitations: { ...invitations, pending: invitations.total - invitations.viewed, expired: 0 },
});

function renderCard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <RunAssessmentChecklist />
    </MemoryRouter>,
  );
}

describe("Z-24 checklist — happy path", () => {
  it("ticks each step from live counts and links to the right tab", async () => {
    mockScenario({
      items: [assessmentRow({ total: 2, viewed: 1, started: 0, submitted: 0 })],
      invitations: { total: 2, viewed: 1, started: 0, submitted: 0 },
      all: 3,
      awaiting: 0,
      gradedOrLater: 1,
      released: 0,
    });
    renderCard();
    // Five ticks done, one to do (release has no released attempt).
    expect(await screen.findAllByText(/\(done\)/)).toHaveLength(5);
    expect(screen.getAllByText(/\(to do\)/)).toHaveLength(1);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(6);
    expect(links[3]?.getAttribute("href")).toBe(`/admin/attempts?assessmentId=${ASSESSMENT_ID}`);
    expect(links[5]?.getAttribute("href")).toBe(`/admin/assessments/${ASSESSMENT_ID}`);
    expect(screen.getByRole("button", { name: "Start a test" })).toBeDefined();
  });

  it("hides the card when all six steps are done, and a link reopens it", async () => {
    mockScenario({
      items: [assessmentRow({ total: 2, viewed: 2, started: 2, submitted: 2 })],
      invitations: { total: 2, viewed: 2, started: 2, submitted: 2 },
      all: 2,
      awaiting: 0,
      gradedOrLater: 2,
      released: 2,
    });
    renderCard();
    const reopen = await screen.findByRole("button", { name: "Show the assessment checklist" });
    expect(screen.queryByRole("heading", { name: "Run an assessment" })).toBeNull();
    fireEvent.click(reopen);
    expect(screen.getByRole("heading", { name: "Run an assessment" })).toBeDefined();
    expect(screen.getAllByText(/\(done\)/)).toHaveLength(6);
  });
});

describe("Z-24 checklist — failure and empty states", () => {
  it("shows a safe fallback when the API fails, without the raw message", async () => {
    mockApi.mockRejectedValue(new AdminApiError(500, { code: "X", message: "SQL internal detail" }));
    renderCard();
    expect(
      await screen.findByText("The checklist could not load. Refresh the page to try again."),
    ).toBeDefined();
    expect(screen.queryByText(/SQL internal detail/)).toBeNull();
    // The primary button still works without the data.
    expect(screen.getByRole("button", { name: "Start a test" })).toBeDefined();
  });

  it("with no assessment, step 1 is to do and links to Start a test", async () => {
    mockScenario({
      items: [],
      invitations: { total: 0, viewed: 0, started: 0, submitted: 0 },
      all: 0,
      awaiting: 0,
      gradedOrLater: 0,
      released: 0,
    });
    renderCard();
    await waitFor(() => expect(screen.getAllByText(/\(to do\)/)).toHaveLength(6));
    const first = screen.getAllByRole("link")[0];
    expect(first?.getAttribute("href")).toBe("/admin/start-test");
    // Only the assessment list call was needed; attempt counts are skipped.
    expect(mockApi.mock.calls.every((c) => String(c[0]).startsWith("/admin/assessments"))).toBe(true);
  });
});

describe("Z-24 checklist — pure helpers", () => {
  it("builds ticks and treats missing counts as zero", () => {
    const steps = buildChecklistSteps({ assessmentId: "a", invitations: { total: 1 } });
    expect(steps.map((s) => s.done)).toEqual([true, true, false, false, false, false]);
    expect(allStepsDone(steps)).toBe(false);
    expect(safeCount(-3)).toBe(0);
    expect(safeCount(Number.NaN)).toBe(0);
    expect(safeCount(4)).toBe(4);
  });

  it("does not tick grading while an attempt still waits", () => {
    const steps = buildChecklistSteps({
      assessmentId: "a",
      invitations: { total: 1, viewed: 1 },
      attempts: { all: 2, awaiting: 1, gradedOrLater: 1, released: 0 },
    });
    expect(steps.find((s) => s.id === "grading")?.done).toBe(false);
  });

  it("encodes the assessment id in step links", () => {
    expect(stepHref("attempts", "a b")).toBe("/admin/attempts?assessmentId=a%20b");
    expect(stepHref("candidates", null)).toBe("/admin/assessments");
  });
});
