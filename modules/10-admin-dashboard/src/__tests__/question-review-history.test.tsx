// EXP-18 pack review page: latest note, note history, Mark disputed and attempts on an older version.
// Synthetic data only. fetch is stubbed; nothing leaves the test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { AdminQuestionReview } from "../pages/question-review.js";

const PACK = {
  pack: { id: "pack-1", name: "Networks basics", status: "live", is_platform: true },
  counts: { in_review: 1, verified: 0, disputed: 0, needs_fix: 0, none: 0 },
  total: 1,
  items: [{
    id: "q-1", type: "mcq", topic: "Ports", points: 1, review_state: "in_review",
    content: { prompt: "Which port does HTTPS use?", options: ["80", "443"], correct: 1 },
    rubric: null, answer_guidance: null, origin: "platform", rights_status: "original",
    source_ref: null, source_url: null,
  }],
};

const NOTES = {
  latest: { id: "n-2", version: 2, state: "needs_fix", note: "Option B is wrong.", author_user_id: "u-1", created_at: "2026-10-18T09:00:00Z" },
  items: [
    { id: "n-2", version: 2, state: "needs_fix", note: "Option B is wrong.", author_user_id: "u-1", created_at: "2026-10-18T09:00:00Z" },
    { id: "n-1", version: 1, state: "in_review", note: "First check done.", author_user_id: null, created_at: "2026-10-17T09:00:00Z" },
  ],
};

const ATTEMPTS = {
  question_id: "q-1",
  current_version: 2,
  total: 7,
  items: [
    { attempt_id: "att-a1", assessment_id: "as-1", assessment_name: "Mock A", candidate_user_id: "c-1", status: "graded", question_version: 1, submitted_at: "2026-10-10T09:00:00Z" },
    { attempt_id: "att-a2", assessment_id: "as-1", assessment_name: "Mock A", candidate_user_id: "c-2", status: "graded", question_version: 1, submitted_at: "2026-10-11T09:00:00Z" },
  ],
};

interface Recorded { method: string; url: URL; body: unknown }
let recorded: Recorded[] = [];

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    recorded.push({ method, url, body });
    let out: unknown = {};
    if (url.pathname === "/api/admin/packs/pack-1/review") out = PACK;
    else if (url.pathname === "/api/admin/questions/q-1/review-notes") out = NOTES;
    else if (url.pathname === "/api/admin/questions/q-1/affected-attempts") out = ATTEMPTS;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function calls(path: string, method = "GET"): Recorded[] {
  return recorded.filter((r) => r.url.pathname === path && r.method === method);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  recorded = [];
});

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/admin/question-bank/pack-1/review"]}>
      <Routes>
        <Route path="/admin/question-bank/:id/review" element={<AdminQuestionReview />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Pack review page: notes, disputes and attempts on an older version", () => {
  it("shows the latest review note on the question card", async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText("Option B is wrong.")).toBeTruthy();
    expect(calls("/api/admin/questions/q-1/review-notes").length).toBeGreaterThan(0);
  });

  it("opens the note history with every note, newest first", async () => {
    stubFetch();
    renderPage();
    await screen.findByText("Option B is wrong.");

    const toggle = screen.getByRole("button", { name: "Note history" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const history = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(history).toBeTruthy();
    const items = within(history as HTMLElement).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Option B is wrong."),
      expect.stringContaining("First check done."),
    ]);
  });

  it("loads attempts on an older version once and shows the total, the first rows and the fixed sentence", async () => {
    stubFetch();
    renderPage();
    await screen.findByText("Option B is wrong.");

    fireEvent.click(screen.getByRole("button", { name: "Attempts on an older version" }));
    expect(await screen.findByText(/7 attempts used an older version of this question/)).toBeTruthy();
    expect(screen.getByText("att-a1")).toBeTruthy();
    expect(screen.getByText("att-a2")).toBeTruthy();
    expect(screen.getByText("Marks are not changed. A correction creates a new version; attempts keep the version they used.")).toBeTruthy();
    expect(calls("/api/admin/questions/q-1/affected-attempts")).toHaveLength(1);
  });

  it("requires a note for Mark disputed, then posts the dispute action with the note", async () => {
    stubFetch();
    renderPage();
    await screen.findByText("Option B is wrong.");

    fireEvent.click(screen.getByRole("button", { name: "Mark disputed" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Mark disputed" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  Two answers are correct.  " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(calls("/api/admin/questions/q-1/review", "POST")).toHaveLength(1));
    expect(calls("/api/admin/questions/q-1/review", "POST")[0]?.body).toEqual({ action: "dispute", note: "Two answers are correct." });
  });

  it("still posts needs_fix with its note from the same dialog", async () => {
    stubFetch();
    renderPage();
    await screen.findByText("Option B is wrong.");

    fireEvent.click(screen.getByRole("button", { name: "Needs fix" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Fix the wording." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark needs fix" }));

    await waitFor(() => expect(calls("/api/admin/questions/q-1/review", "POST")).toHaveLength(1));
    expect(calls("/api/admin/questions/q-1/review", "POST")[0]?.body).toEqual({ action: "needs_fix", note: "Fix the wording." });
  });
});
