// EXP-12 wave 1: the Affected attempts panel. Synthetic data only; fetch is stubbed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { AffectedAttemptsPanel } from "../pages/affected-attempts-panel.js";

const ITEM = {
  attempt_id: "att-12345678-aaaa", assessment_id: "as-1", assessment_name: "Mock A", candidate_user_id: "c-1",
  status: "released", released: true, question_id: "q-1", question_version: 1, current_version: 2,
  score_earned: 2, score_max: 5, submitted_at: "2026-10-10T09:00:00Z", review: null as unknown,
};

interface Recorded { method: string; url: URL; body: unknown }
let recorded: Recorded[] = [];

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const method = init?.method ?? "GET";
    recorded.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const out = method === "PUT" ? { outcome: "needs_follow_up", reviewed_at: "2026-10-23T09:00:00Z" } : { question_id: "q-1", current_version: 2, total: 1, items: [ITEM] };
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  recorded = [];
});

describe("Affected attempts panel", () => {
  it("shows the notice, the columns, and sends a review with the chosen outcome and note", async () => {
    stubFetch();
    render(<AffectedAttemptsPanel questionId="q-1" />);
    expect(await screen.findByText("A corrected key does not change any mark. Review each attempt by hand. Automatic rescoring is not available.")).toBeTruthy();
    expect(await screen.findByText("2 of 5")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy(); // released
    expect(screen.getByText("att-1234")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    fireEvent.change(screen.getByRole("combobox", { name: /Outcome/ }), { target: { value: "needs_follow_up" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Ask the owner.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() => expect(recorded.filter((r) => r.method === "PUT")).toHaveLength(1));
    const put = recorded.find((r) => r.method === "PUT")!;
    expect(put.url.pathname).toBe("/api/admin/questions/q-1/affected-attempts/att-12345678-aaaa/review");
    expect(put.body).toEqual({ outcome: "needs_follow_up", note: "Ask the owner." });
  });

  it("passes the reviewed filter to the list", async () => {
    stubFetch();
    render(<AffectedAttemptsPanel questionId="q-1" />);
    await screen.findByText("2 of 5");
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by review" }), { target: { value: "no" } });
    await waitFor(() => expect(recorded.some((r) => r.url.searchParams.get("reviewed") === "no")).toBe(true));
  });
});
