// X6a live monitor page. Synthetic data only. fetch is stubbed; timers are fake.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import React from "react";

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { LiveMonitor, LIVE_MONITOR_POLL_MS } from "../pages/live-monitor.js";

const BODY = {
  counts: { invited: 10, not_started: 4, in_progress: 1, submitted: 5 },
  in_progress: [
    { attempt_id: "a1", user_id: "u1", name: "Asha Rao", email: "asha@example.test", started_at: "2026-10-28T04:00:00Z", last_seen_at: "2026-10-28T04:29:00Z" },
  ],
  server_time: "2026-10-28T04:30:00Z",
};

let calls = 0;

function setVisibility(v: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = 0;
  setVisibility("visible");
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls += 1;
    expect(new URL(input, "http://localhost").pathname).toBe("/api/admin/assessments/asm-1/live-monitor");
    return new Response(JSON.stringify(BODY), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/admin/assessments/asm-1/live"]}>
        <Routes><Route path="/admin/assessments/:id/live" element={<LiveMonitor />} /></Routes>
      </MemoryRouter>,
    );
  });
}

describe("Live monitor page", () => {
  it("shows the counts and the in-progress candidate with a last seen age from the server clock", async () => {
    await renderPage();
    expect(screen.getByText("Asha Rao")).toBeTruthy();
    expect(screen.getByText("1 min ago")).toBeTruthy();
    expect(screen.getByText("Not started").nextSibling?.textContent).toBe("4");
    expect(calls).toBe(1);
  });

  it("polls every 15 seconds while visible", async () => {
    await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MONITOR_POLL_MS); });
    expect(calls).toBe(2);
  });

  it("pauses while the tab is hidden and loads again when it is visible", async () => {
    await renderPage();
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MONITOR_POLL_MS * 3); });
    expect(calls).toBe(1);
    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toBe(2);
  });

  it("stops polling after unmount", async () => {
    await renderPage();
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MONITOR_POLL_MS * 2); });
    expect(calls).toBe(1);
  });
});
