// EXP-38: "Students per assessment" field in the platform billing drawer plan edit.
// Value 1 to 1000000, or Unlimited (null). The internal tier is always unlimited.
// Saves through updateTenantPlan (PATCH /api/admin/super/tenants/:id/plan) inside the MFA guard.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { getTenantBillingDetail, updateTenantPlan } = vi.hoisted(() => ({
  getTenantBillingDetail: vi.fn(),
  updateTenantPlan: vi.fn(),
}));

vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message); this.status = status; this.apiError = apiError;
    }
  },
  getTenantBillingDetail: (...a: unknown[]) => getTenantBillingDetail(...a),
  updateTenantPlan: (...a: unknown[]) => updateTenantPlan(...a),
  tenantBillingCsvUrl: () => "/csv",
  getTenantEntitlements: () => Promise.resolve({ entitlements: [] }),
  getTenantContentScopes: () => Promise.resolve({ domains: [], packs: [] }),
  listPlatformPublishedPacks: () => Promise.resolve({ packs: [] }),
  grantTenantEntitlement: vi.fn(),
  revokeTenantEntitlement: vi.fn(),
}));
vi.mock("../components/useMfaGuard.js", () => ({
  useMfaGuard: () => ({ guard: (fn: () => Promise<void>) => fn(), stepUp: null }),
}));
vi.mock("../pages/platform/AiGradingScopeCard.js", () => ({ AiGradingScopeCard: () => null }));
vi.mock("../pages/platform/CreditsCard.js", () => ({ CreditsCard: () => null }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { BillingDrawer } from "../pages/platform/BillingDrawer.js";

const tenant = { id: "t1", slug: "acme", name: "Acme", status: "active" } as never;

function detail(over: Record<string, unknown> = {}): unknown {
  return {
    tenant_id: "t1", tier: "pro", included_credits: 250, status: "active",
    cycle_start: "2026-10-01T00:00:00Z", used: 0, remaining: 250, overage: 0,
    usage_status: "ok", recent_events: [], max_invited_per_assessment: 150, ...over,
  };
}

function open(d: unknown = detail()): void {
  getTenantBillingDetail.mockResolvedValue(d);
  render(<BillingDrawer tenant={tenant} onClose={vi.fn()} onPlanUpdated={vi.fn()} />);
}

const input = (): HTMLInputElement => document.getElementById("invite-limit-input-t1") as HTMLInputElement;
const unlimited = (): HTMLInputElement => document.getElementById("invite-unlimited-t1") as HTMLInputElement;
const tier = (): HTMLSelectElement => document.getElementById("tier-select-t1") as HTMLSelectElement;

// The drawer reads the viewport width on mount; jsdom has no matchMedia.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
});

beforeEach(() => {
  getTenantBillingDetail.mockReset();
  updateTenantPlan.mockReset();
  updateTenantPlan.mockResolvedValue({ auditId: "a1" });
});

afterEach(() => {
  cleanup();
});

describe("BillingDrawer students per assessment (EXP-38)", () => {
  it("shows the saved limit next to the tier", async () => {
    open();
    expect(await screen.findByText("150 students per assessment")).toBeTruthy();
    expect(input().value).toBe("150");
    expect(unlimited().checked).toBe(false);
  });

  it("shows Unlimited when the saved limit is null", async () => {
    open(detail({ max_invited_per_assessment: null }));
    expect(await screen.findByText("Unlimited students per assessment")).toBeTruthy();
    expect(unlimited().checked).toBe(true);
    expect(input().disabled).toBe(true);
  });

  it("saves a typed limit as maxInvitedPerAssessment", async () => {
    open();
    await screen.findByText("150 students per assessment");
    fireEvent.change(input(), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(updateTenantPlan).toHaveBeenCalledTimes(1));
    expect(updateTenantPlan).toHaveBeenCalledWith("t1", { tier: "pro", includedCredits: 250, maxInvitedPerAssessment: 300 });
  });

  it("saves null when Unlimited is ticked", async () => {
    open();
    await screen.findByText("150 students per assessment");
    fireEvent.click(unlimited());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(updateTenantPlan).toHaveBeenCalledTimes(1));
    expect(updateTenantPlan.mock.calls[0]?.[1]).toMatchObject({ maxInvitedPerAssessment: null });
  });

  it("refuses 0 and a number above 1000000 before any request", async () => {
    open();
    await screen.findByText("150 students per assessment");
    for (const bad of ["0", "1000001", "2.5"]) {
      fireEvent.change(input(), { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText(/Students per assessment must be a whole number from 1 to 1000000/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    }
    expect(updateTenantPlan).not.toHaveBeenCalled();
  });

  it("the internal tier is unlimited and saves null", async () => {
    open();
    await screen.findByText("150 students per assessment");
    fireEvent.change(tier(), { target: { value: "internal" } });
    expect(unlimited().checked).toBe(true);
    expect(unlimited().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(updateTenantPlan).toHaveBeenCalledTimes(1));
    expect(updateTenantPlan.mock.calls[0]?.[1]).toMatchObject({ tier: "internal", maxInvitedPerAssessment: null });
  });
});
