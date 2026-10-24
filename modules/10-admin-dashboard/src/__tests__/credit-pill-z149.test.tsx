// Z-149 / Z-156: useCompanyUsage shares one fetch; CreditPill shows three states and hides when it should.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { axe } from "vitest-axe";

const getCompanyUsage = vi.fn();
vi.mock("../api.js", () => ({ getCompanyUsage: () => getCompanyUsage() }));
let role = "admin";
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { email: "a@b.c", role } } }) }));

import { useCompanyUsage, resetCompanyUsageForTests } from "../hooks/useCompanyUsage.js";
import { CreditPill } from "../components/CreditPill.js";

function usage(over: Record<string, unknown> = {}) {
  return {
    tier: "free", included_credits: 250, used: 0, remaining: 250, overage: 0, status: "ok",
    credits: { unlimited: false, has_grants: true, balance: 200, next_expiry: null, grants: [], burn_by_type: { mock: 0, real: 0, real_camera: 0 }, ai_answers: 0,
      held: 40, held_invites: 2, available: 160, total_granted: 250, used_this_month: 50, ...over },
  };
}

function Loc(): React.ReactElement { return <div data-testid="loc">{useLocation().pathname + useLocation().search}</div>; }
function renderPill() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes><Route path="*" element={<><CreditPill /><Loc /></>} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { resetCompanyUsageForTests(); role = "admin"; getCompanyUsage.mockReset(); });
afterEach(cleanup);

describe("useCompanyUsage", () => {
  it("two consumers share one fetch; refetch reads again", async () => {
    getCompanyUsage.mockResolvedValue(usage());
    let refetch: () => Promise<void> = async () => undefined;
    function A(): React.ReactElement { const u = useCompanyUsage(); refetch = u.refetch; return <i data-testid="a">{u.usage ? "y" : "n"}</i>; }
    function B(): React.ReactElement { return <i data-testid="b">{useCompanyUsage().usage ? "y" : "n"}</i>; }
    render(<><A /><B /></>);
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("y"));
    expect(screen.getByTestId("a").textContent).toBe("y");
    expect(getCompanyUsage).toHaveBeenCalledTimes(1);
    await refetch();
    expect(getCompanyUsage).toHaveBeenCalledTimes(2);
  });
});

describe("CreditPill", () => {
  it("normal: shows available / total, tooltip text, click opens the Plan and usage tab", async () => {
    getCompanyUsage.mockResolvedValue(usage());
    renderPill();
    const pill = await screen.findByTestId("credit-pill");
    expect(pill.textContent).toContain("160 / 250");
    expect(pill.getAttribute("data-level")).toBe("normal");
    expect(pill.getAttribute("title")).toBe("160 available. 40 reserved for 2 invited students. 50 used this month.");
    expect(pill.getAttribute("data-help-id")).toBe("admin.shell.credit_pill");
    fireEvent.click(pill);
    expect(screen.getByTestId("loc").textContent).toBe("/admin/settings?tab=plan");
  });

  it("low at 20 percent or less, zero at 0", async () => {
    getCompanyUsage.mockResolvedValue(usage({ available: 50 }));
    renderPill();
    expect((await screen.findByTestId("credit-pill")).getAttribute("data-level")).toBe("low");
    cleanup(); resetCompanyUsageForTests();
    getCompanyUsage.mockResolvedValue(usage({ available: 0 }));
    renderPill();
    const z = await screen.findByTestId("credit-pill");
    expect(z.getAttribute("data-level")).toBe("zero");
    expect(z.textContent).toContain("0 / 250");
  });

  it("is hidden for super admin, unlimited plans, no ledger and a failed read", async () => {
    role = "super_admin";
    getCompanyUsage.mockResolvedValue(usage());
    renderPill();
    await waitFor(() => expect(getCompanyUsage).toHaveBeenCalled());
    expect(screen.queryByTestId("credit-pill")).toBeNull();
    for (const [r, u] of [
      ["admin", usage({ unlimited: true })],
      ["admin", usage({ has_grants: false })],
    ] as const) {
      cleanup(); resetCompanyUsageForTests(); role = r; getCompanyUsage.mockReset(); getCompanyUsage.mockResolvedValue(u);
      renderPill();
      await waitFor(() => expect(getCompanyUsage).toHaveBeenCalled());
      await new Promise((res) => setTimeout(res, 0));
      expect(screen.queryByTestId("credit-pill")).toBeNull();
    }
    cleanup(); resetCompanyUsageForTests(); getCompanyUsage.mockReset(); getCompanyUsage.mockRejectedValue(new Error("x"));
    renderPill();
    await waitFor(() => expect(getCompanyUsage).toHaveBeenCalled());
    await new Promise((res) => setTimeout(res, 0));
    expect(screen.queryByTestId("credit-pill")).toBeNull();
  });

  it("has no axe violations in the three states", async () => {
    for (const available of [160, 50, 0]) {
      cleanup(); resetCompanyUsageForTests(); getCompanyUsage.mockReset();
      getCompanyUsage.mockResolvedValue(usage({ available }));
      const { container } = renderPill();
      await screen.findByTestId("credit-pill");
      expect((await axe(container)).violations).toEqual([]);
    }
  });
});
