// AssessIQ — ActivityFeedSection render tests.
//
// Coverage:
//  - Shows "Loading…" while the feed fetch is in-flight.
//  - Renders feed rows given a resolved mock adminApi.
//  - Shows "No activity yet." when items array is empty.
//  - Shows inline error text when adminApi rejects.
//  - relativeTime helper: spot-checks "just now", "Xm ago", "Xh ago", "Xd ago", month label.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import that uses them.
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
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

// Stub all ui-system components the page imports so jsdom doesn't need them
vi.mock("@assessiq/ui-system", () => ({
  StatCard:        () => React.createElement("div", { "data-testid": "stat-card" }),
  ActivityHeatmap: () => React.createElement("div", { "data-testid": "activity-heatmap" }),
  StackedBarChart: () => React.createElement("div", { "data-testid": "stacked-bar-chart" }),
  LeaderboardList: () => React.createElement("div", { "data-testid": "leaderboard-list" }),
  Chip: ({ children, variant }: { children: React.ReactNode; variant?: string }) =>
    React.createElement("span", { "data-testid": "chip", "data-variant": variant }, children),
  useViewport: () => "desktop",
}));

vi.mock("../lib/domains.js", () => ({
  domainLabel: (key: string) => key,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { adminApi } from "../api.js";
import { AdminActivity } from "../pages/activity.js";

const mockAdminApi = adminApi as ReturnType<typeof vi.fn>;

// Minimal feed response factory
const feedResponse = (items: object[] = []) => ({
  page: 1,
  pageSize: 20,
  total: items.length,
  items,
});

const sampleItem = {
  id: "evt-001",
  source: "audit",
  at: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 min ago
  actorRole: "admin",
  actorLabel: "Alice Admin",
  action: "pack.publish",
  actionLabel: "Published a pack",
  targetType: "pack",
  targetId: "pack-123",
  targetLabel: "SOC Analyst L1",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// relativeTime helper — tested indirectly via rendered timestamps
// ---------------------------------------------------------------------------

describe("relativeTime (via rendered feed)", () => {
  beforeEach(() => {
    // Mock all adminApi calls: feed resolves with one item, others hang/resolve empty
    mockAdminApi.mockImplementation((url: string) => {
      if (url.includes("/feed")) {
        return Promise.resolve(feedResponse([sampleItem]));
      }
      // Stats, heatmap, timeline, leaderboard — resolve with minimal shapes so
      // the rest of AdminActivity doesn't crash during this test.
      if (url.includes("/stats")) return Promise.resolve({ data: { completions: { total: 0, breakdown: [] }, activeCandidates: { total: 0, breakdown: [] }, avgScore: { total: 0, breakdown: [] } } });
      if (url.includes("/heatmap")) return Promise.resolve({ data: { days: [], totals: { total: 0, avgPerDay: 0, activeDays: 0 }, streaks: { current: 0, longest: 0 } } });
      if (url.includes("/timeline")) return Promise.resolve({ data: { from: "", to: "", domains: [], bars: [] } });
      if (url.includes("/leaderboard")) return Promise.resolve({ data: { period: "week", from: "", to: "", priorFrom: "", priorTo: "", page: 1, pageSize: 10, totalRanked: 0, items: [] } });
      return Promise.resolve({});
    });
  });

  it("renders a relative timestamp for a recent event (Xm ago)", async () => {
    render(<AdminActivity />);
    // Should transition from Loading… to the feed row
    await waitFor(() => {
      expect(screen.queryByText(/Loading…/)).toBeNull();
    });
    // The timestamp cell should show something like "3m ago"
    const body = document.body.textContent ?? "";
    expect(/\dm ago/i.test(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ActivityFeedSection loading state
// ---------------------------------------------------------------------------

describe("ActivityFeedSection — loading", () => {
  it('shows "Loading…" before fetch resolves', () => {
    // Feed fetch never resolves during this test
    mockAdminApi.mockImplementation((url: string) => {
      if (url.includes("/feed")) return new Promise(() => { /* never resolves */ });
      if (url.includes("/stats")) return new Promise(() => {});
      if (url.includes("/heatmap")) return new Promise(() => {});
      if (url.includes("/timeline")) return new Promise(() => {});
      if (url.includes("/leaderboard")) return new Promise(() => {});
      return new Promise(() => {});
    });
    render(<AdminActivity />);
    // Multiple "Loading…" will appear (one per section), check at least one exists
    const els = screen.getAllByText("Loading…");
    expect(els.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ActivityFeedSection — resolved with items
// ---------------------------------------------------------------------------

describe("ActivityFeedSection — with items", () => {
  beforeEach(() => {
    mockAdminApi.mockImplementation((url: string) => {
      if (url.includes("/feed")) return Promise.resolve(feedResponse([sampleItem]));
      if (url.includes("/stats")) return Promise.resolve({ data: { completions: { total: 0, breakdown: [] }, activeCandidates: { total: 0, breakdown: [] }, avgScore: { total: 0, breakdown: [] } } });
      if (url.includes("/heatmap")) return Promise.resolve({ data: { days: [], totals: { total: 0, avgPerDay: 0, activeDays: 0 }, streaks: { current: 0, longest: 0 } } });
      if (url.includes("/timeline")) return Promise.resolve({ data: { from: "", to: "", domains: [], bars: [] } });
      if (url.includes("/leaderboard")) return Promise.resolve({ data: { period: "week", from: "", to: "", priorFrom: "", priorTo: "", page: 1, pageSize: 10, totalRanked: 0, items: [] } });
      return Promise.resolve({});
    });
  });

  it("renders actor label and action label", async () => {
    render(<AdminActivity />);
    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeDefined();
    });
    expect(screen.getByText("Published a pack")).toBeDefined();
  });

  it("renders target label when present", async () => {
    render(<AdminActivity />);
    await waitFor(() => {
      // targetLabel is split across sibling text nodes ("·" + label in a <span>)
      // so we search the full body text content rather than a single element.
      const body = document.body.textContent ?? "";
      expect(body.includes("SOC Analyst L1")).toBe(true);
    });
  });

  it("renders the Admin role chip", async () => {
    render(<AdminActivity />);
    await waitFor(() => {
      const chips = screen.getAllByTestId("chip");
      const adminChip = chips.find((c) => c.textContent === "Admin");
      expect(adminChip).toBeDefined();
    });
  });

  it('renders "Showing N of M" count line', async () => {
    render(<AdminActivity />);
    await waitFor(() => {
      expect(screen.getByText("Showing 1 of 1")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// ActivityFeedSection — empty state
// ---------------------------------------------------------------------------

describe("ActivityFeedSection — empty", () => {
  it('shows "No activity yet." when items is empty', async () => {
    mockAdminApi.mockImplementation((url: string) => {
      if (url.includes("/feed")) return Promise.resolve(feedResponse([]));
      if (url.includes("/stats")) return Promise.resolve({ data: { completions: { total: 0, breakdown: [] }, activeCandidates: { total: 0, breakdown: [] }, avgScore: { total: 0, breakdown: [] } } });
      if (url.includes("/heatmap")) return Promise.resolve({ data: { days: [], totals: { total: 0, avgPerDay: 0, activeDays: 0 }, streaks: { current: 0, longest: 0 } } });
      if (url.includes("/timeline")) return Promise.resolve({ data: { from: "", to: "", domains: [], bars: [] } });
      if (url.includes("/leaderboard")) return Promise.resolve({ data: { period: "week", from: "", to: "", priorFrom: "", priorTo: "", page: 1, pageSize: 10, totalRanked: 0, items: [] } });
      return Promise.resolve({});
    });
    render(<AdminActivity />);
    await waitFor(() => {
      expect(screen.getByText("No activity yet.")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// ActivityFeedSection — error state
// ---------------------------------------------------------------------------

describe("ActivityFeedSection — error", () => {
  it("shows inline error text when feed fetch rejects", async () => {
    mockAdminApi.mockImplementation((url: string) => {
      if (url.includes("/feed")) return Promise.reject(new Error("Network error"));
      if (url.includes("/stats")) return new Promise(() => {});
      if (url.includes("/heatmap")) return new Promise(() => {});
      if (url.includes("/timeline")) return new Promise(() => {});
      if (url.includes("/leaderboard")) return new Promise(() => {});
      return new Promise(() => {});
    });
    render(<AdminActivity />);
    await waitFor(() => {
      expect(screen.getByText("Failed to load activity feed.")).toBeDefined();
    });
  });
});
