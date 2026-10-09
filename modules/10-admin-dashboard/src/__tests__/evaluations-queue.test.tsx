// AssessIQ — smoke tests for the super-admin evaluation queue
// (scoring / result-release, spec 2026-10-01 §5b — frontend half).
//
//   Q1  rows render with tenant, assessment, counts, age tones, sent-back marker
//       — and never a candidate name / email (blind evaluation)
//   Q2  a complete row can be ticked and released in bulk (right endpoint + body)
//   Q3  "Evaluate next" opens the oldest row; the company filter narrows the list

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

import { AdminEvaluationsQueue } from "../pages/evaluations-queue.js";

const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const READY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const base = {
  assessment_id: "as-1",
  level_label: "L1",
  submitted_at: "2026-09-29T10:00:00.000Z",
  written_count: 5,
  kql_count: 0,
  status: "pending_admin_grading",
  complete: false,
  grading_in_progress: false,
  sent_back: false,
  sent_back_note: null,
  ai_paused: false,
};

// Oldest first, as the API returns them. The first row also carries stray
// candidate fields the API must never send — the page must not render them.
const ROWS = [
  {
    ...base,
    attempt_id: OLD,
    tenant_id: "t-acme",
    tenant_name: "Acme College",
    assessment_name: "SOC Analyst L1",
    age_hours: 52.4,
    kql_count: 1,
    sent_back: true,
    sent_back_note: "Q2 looks too harsh",
    candidate_email: "pii@example.com",
    candidate_name: "Priya Sharma",
  },
  {
    ...base,
    attempt_id: READY,
    tenant_id: "t-beta",
    tenant_name: "Beta Corp",
    assessment_name: "Threat Hunting L2",
    age_hours: 30.1,
    status: "graded",
    complete: true,
  },
  {
    ...base,
    attempt_id: NEW,
    tenant_id: "t-acme",
    tenant_name: "Acme College",
    assessment_name: "SOC Analyst L2",
    age_hours: 3.2,
  },
];

function Landing(): React.ReactElement {
  const { attemptId } = useParams();
  return <div data-testid="landing">{attemptId}</div>;
}

function mockApi(items: typeof ROWS = ROWS): void {
  adminApi.mockImplementation(async (path: string) => {
    if (path === "/admin/super/evaluations") {
      return { items, counts: { pending: 3, older_than_24h: 2 } };
    }
    if (path === "/admin/super/eval-gate") {
      return { mode: "enforce", approved: false };
    }
    if (path.startsWith("/admin/super/grading-quality")) {
      return {
        items: [
          { prompt_version_sha: "anchors:aaaa1111;band:bbbb2222;escalate:-", ai_grades: 10, overrides: 2, override_rate: 0.2, mean_abs_band_delta: 1, mean_abs_score_delta_pct: 25 },
        ],
      };
    }
    if (path === "/admin/super/evaluations/release-to-tenant") {
      return { released: [READY], skipped: [] };
    }
    throw new Error(`unexpected adminApi call: ${path}`);
  });
}

async function renderQueue(items: typeof ROWS = ROWS): Promise<void> {
  mockApi(items);
  render(
    <MemoryRouter initialEntries={["/admin/platform/evaluations"]}>
      <Routes>
        <Route path="/admin/platform/evaluations" element={<AdminEvaluationsQueue />} />
        <Route path="/admin/platform/evaluations/:attemptId" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Threat Hunting L2");
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminEvaluationsQueue", () => {
  it("Q1 renders rows with age tones and the sent-back note, and no candidate PII", async () => {
    await renderQueue();

    // Table cells only — the company filter also lists each name as an <option>.
    const cells = (text: string) => screen.getAllByText(text).filter((el) => el.tagName !== "OPTION");
    expect(cells("Acme College")).toHaveLength(2);
    expect(cells("Beta Corp")).toHaveLength(1);
    expect(screen.getByText("SOC Analyst L1")).toBeTruthy();
    expect(screen.getByText("5 written · 1 KQL")).toBeTruthy();

    // 52 h → red, 30 h → amber, 3 h → neutral.
    expect(document.querySelectorAll('[data-age-tone="late"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-age-tone="warn"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-age-tone="ok"]')).toHaveLength(1);
    expect(screen.getByText("2d 4h")).toBeTruthy();

    expect(screen.getByText("Sent back")).toBeTruthy();
    expect(screen.getByText("Q2 looks too harsh")).toBeTruthy();
    expect(screen.getByText("Ready to release")).toBeTruthy();

    // Blind evaluation: nothing about the candidate reaches the page.
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("pii@example.com");
    expect(text).not.toContain("Priya Sharma");
  });

  it("Q2 releases ticked complete rows in bulk to the right endpoint", async () => {
    await renderQueue();

    // Only the finished row can be ticked.
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.disabled)).toEqual([true, false, true]);
    expect((screen.getByRole("button", { name: /Release selected to company/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(boxes[1] as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: "Release selected to company (1)" }));

    await screen.findByText(/Released 1 to its company/);
    const call = adminApi.mock.calls.find((c) => c[0] === "/admin/super/evaluations/release-to-tenant");
    expect(call).toBeTruthy();
    expect((call?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ attempt_ids: [READY] });
  });

  it("Q3 'Evaluate next' opens the oldest row; the company filter narrows the list", async () => {
    await renderQueue();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "t-beta" } });
    expect(screen.queryByText("SOC Analyst L1")).toBeNull();
    expect(screen.getByText("Threat Hunting L2")).toBeTruthy();

    // Back to all companies; the oldest row is the first one.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Evaluate next" }));
    const landing = await screen.findByTestId("landing");
    expect(landing.textContent).toBe(OLD);
  });

  it("Q5 FU-A11: a paused company's row shows 'AI paused' and 'Evaluate next' skips it", async () => {
    const [first, ...rest] = ROWS;
    await renderQueue([{ ...first!, ai_paused: true }, ...rest]);
    expect(screen.getByText("AI paused")).toBeTruthy();
    expect(document.querySelectorAll('[data-help-id="admin.evaluations.queue.ai_paused"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Evaluate next" }));
    const landing = await screen.findByTestId("landing");
    expect(landing.textContent).toBe(READY);
  });

  it("Q4 shows the eval-gate banner when prompts are not approved, and the quality table", async () => {
    await renderQueue();
    expect(await screen.findByText("AI grading is blocked: prompts changed since the last passing eval.")).toBeTruthy();
    expect(await screen.findByText("anchors:aaaa1111;band:bbbb2222;escalate:-")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
  });
});
