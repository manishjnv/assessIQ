// Z-80: a 403 TIER_NOT_INCLUDED opens the shared "Contact us" popup. Synthetic data only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({ adminApi: (...a: unknown[]) => adminApi(...a) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

import WebhooksPage from "../pages/webhooks.js";
import { isTierLocked } from "../api/tier-lock.js";

const tierDenied = () =>
  Object.assign(new Error("Your plan does not include this feature."), {
    status: 403,
    apiError: { code: "TIER_NOT_INCLUDED", message: "Your plan does not include this feature." },
  });

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("locked feature popup (Z-80)", () => {
  it("recognises only the tier 403 shape", () => {
    expect(isTierLocked(tierDenied())).toBe(true);
    expect(isTierLocked(Object.assign(new Error("no"), { status: 403, apiError: { code: "FORBIDDEN", message: "no" } }))).toBe(false);
    expect(isTierLocked(new Error("network down"))).toBe(false);
  });

  it("opens the Contact us popup when the webhooks API answers TIER_NOT_INCLUDED", async () => {
    adminApi.mockRejectedValue(tierDenied());
    render(<WebhooksPage />);
    expect(await screen.findByText("Full access needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Contact us" })).toBeTruthy();
  });
});
