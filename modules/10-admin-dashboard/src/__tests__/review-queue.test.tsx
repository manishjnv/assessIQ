// EXP-18 review queue page. Synthetic data only. fetch is stubbed; nothing leaves the test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import React from "react";

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { ReviewQueue } from "../pages/review-queue.js";

const COUNTS = { in_review: 2, verified: 5, disputed: 1, needs_fix: 1, none: 3 };
const ITEM = {
  id: "q-1", pack_id: "pack-1", pack_name: "Networks basics", type: "mcq", topic: "Ports", status: "active",
  version: 2, review_state: "in_review", origin: "platform", rights_status: "original",
  updated_at: "2026-10-19T09:00:00Z", report_count: 0,
  latest_note: { note: "Check the port number in option B.", state: "needs_fix", created_at: "2026-10-18T09:00:00Z" },
};
const ITEM_2 = {
  ...ITEM, id: "q-2", pack_id: "pack-2", pack_name: "Linux basics", topic: "Permissions",
  review_state: "verified", latest_note: null,
};

let calls: URL[] = [];

function stubFetch(handler: (url: URL) => { status?: number; body: unknown }): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    calls.push(url);
    const out = handler(url);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  calls = [];
});

function renderPage(): void {
  render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
}

describe("Review queue page", () => {
  it("loads the open state and shows each tab with its count", async () => {
    stubFetch(() => ({ body: { counts: COUNTS, reported: 2, total: 2, items: [ITEM, ITEM_2] } }));
    renderPage();
    await screen.findByText("Networks basics");

    expect(calls[0]?.pathname).toBe("/api/admin/review-queue");
    expect(calls[0]?.searchParams.get("state")).toBe("open");
    expect(calls[0]?.searchParams.get("page")).toBe("1");
    expect(calls[0]?.searchParams.get("pageSize")).toBe("25");

    const labels = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(labels).toEqual([
      "Needs review (4)", "In review (2)", "Disputed (1)", "Needs fix (1)", "Verified (5)", "Not set (3)", "Reported (2)", "All (12)",
    ]);
    expect(screen.getByRole("tab", { name: /Needs review/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Showing 1 to 2 of 2 questions.")).toBeTruthy();
  });

  it("links each row to the pack review page and shows the latest note or a plain placeholder", async () => {
    stubFetch(() => ({ body: { counts: COUNTS, total: 2, items: [ITEM, ITEM_2] } }));
    renderPage();
    await screen.findByText("Networks basics");

    const link = screen.getByRole("link", { name: "Open review for Ports in Networks basics" });
    expect(link.getAttribute("href")).toBe("/admin/question-bank/pack-1/review");
    expect(screen.getByText("Check the port number in option B.")).toBeTruthy();
    expect(screen.getByText("No note")).toBeTruthy();
  });

  it("asks for the chosen state and goes back to page 1", async () => {
    stubFetch(() => ({ body: { counts: COUNTS, total: 0, items: [] } }));
    renderPage();
    await screen.findByText("Nothing waits for review.");

    fireEvent.click(screen.getByRole("tab", { name: "Verified (5)" }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last?.searchParams.get("state")).toBe("verified");
      expect(last?.searchParams.get("page")).toBe("1");
    });
    expect(screen.getByRole("tab", { name: "Verified (5)" }).getAttribute("aria-selected")).toBe("true");
  });

  it("pages through the results with Previous and Next", async () => {
    stubFetch(() => ({ body: { counts: COUNTS, total: 60, items: [ITEM] } }));
    renderPage();
    await screen.findByText("Page 1 of 3");

    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 3");
    expect(calls[calls.length - 1]?.searchParams.get("page")).toBe("2");
  });

  it("shows the server message in plain words when the list fails", async () => {
    stubFetch(() => ({ status: 500, body: { error: { code: "INTERNAL", message: "The review queue is not available right now." } } }));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The review queue is not available right now.");
  });

  it("shows the empty message for the open state when nothing waits", async () => {
    stubFetch(() => ({ body: { counts: { in_review: 0, verified: 0, disputed: 0, needs_fix: 0, none: 0 }, total: 0, items: [] } }));
    renderPage();
    expect(await screen.findByText("Nothing waits for review.")).toBeTruthy();
    expect(screen.getByText("No questions match this filter.")).toBeTruthy();
  });

  it("EXP-28: the Reported tab asks for state=reported and each row shows its candidate report count", async () => {
    stubFetch((url) => ({
      body: url.searchParams.get("state") === "reported"
        ? { counts: COUNTS, reported: 1, total: 1, items: [{ ...ITEM, report_count: 3 }] }
        : { counts: COUNTS, reported: 1, total: 2, items: [ITEM, ITEM_2] },
    }));
    renderPage();
    await screen.findByText("Networks basics");
    expect(screen.getAllByText("None").length).toBeGreaterThan(0); // no reports yet on the open list
    fireEvent.click(screen.getByRole("tab", { name: /Reported/ }));
    await screen.findByText("3 from candidates");
    await waitFor(() => expect(calls.some((c) => c.searchParams.get("state") === "reported")).toBe(true));
  });
});
