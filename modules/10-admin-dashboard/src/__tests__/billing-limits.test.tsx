// PT-4 — "Plan limits" rows on the billing page card.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const { getCompanyUsage } = vi.hoisted(() => ({ getCompanyUsage: vi.fn() }));

vi.mock("../api.js", () => ({
  getCompanyUsage: (...a: unknown[]) => getCompanyUsage(...a),
  getGlobalAiGenerateMode: vi.fn(),
  updateTenantAiGenerateMode: vi.fn(),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/UsageBanner.js", () => ({ usageMessage: () => null }));
vi.mock("../pages/tenant-settings.js", () => ({ TenantSettings: () => null }));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { role: "admin" }, tenant: { id: "t1" } } }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams("tab=plan")] }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { AdminBilling } from "../pages/billing.js";

const base = {
  tier: "free",
  included_credits: 250,
  used: 30,
  remaining: 22,
  overage: 0,
  status: "ok",
  ai_answers_used: 4,
  ai_answers_included: 20,
};

afterEach(() => {
  cleanup();
  getCompanyUsage.mockReset();
});

describe("AdminBilling plan limits", () => {
  it("shows Starter limits and the not-enforced note", async () => {
    getCompanyUsage.mockResolvedValue({
      ...base,
      tier_limits: { licensed_packs: 2, per_drive_candidates: 200, overage_hard_cap_ratio: 1.2 },
      tiers_enforced: false,
    });
    render(<AdminBilling />);
    await waitFor(() => expect(screen.getByText("Plan limits")).toBeTruthy());
    expect(screen.getByText("120 % of included")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText("4 / 20")).toBeTruthy();
    expect(screen.getByText("Plan limits are shown for information and are not enforced yet.")).toBeTruthy();
    expect(document.querySelector('[data-help-id="admin.settings.billing.limits"]')).toBeTruthy();
    expect(document.querySelector('[data-help-id="admin.settings.billing.limits.enforced"]')).toBeTruthy();
  });

  it("shows Unlimited / Billed per credit for Growth and hides the note when enforced", async () => {
    getCompanyUsage.mockResolvedValue({
      ...base,
      tier: "pro",
      tier_limits: { licensed_packs: null, per_drive_candidates: null, overage_hard_cap_ratio: null },
      tiers_enforced: true,
    });
    render(<AdminBilling />);
    await waitFor(() => expect(screen.getByText("Plan limits")).toBeTruthy());
    expect(screen.getAllByText("Unlimited").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Billed per credit")).toBeTruthy();
    expect(screen.queryByText(/not enforced yet/)).toBeNull();
  });
});
