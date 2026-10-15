// RW-45 — Account security page: regenerate recovery codes.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const regenerate = vi.fn();

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children),
  useNavigate: () => vi.fn(),
}));
vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
  regenerateRecoveryCodesApi: (...a: unknown[]) => regenerate(...a),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
let enrolled = true;
vi.mock("../session.js", () => ({
  useAdminSession: () => ({ session: { totpEnrolled: enrolled, user: { id: "u1" } }, loading: false }),
}));

import { AdminAccountSecurity } from "../pages/account-security.js";
import { AdminApiError } from "../api.js";

afterEach(() => { cleanup(); regenerate.mockReset(); enrolled = true; });

async function submit(): Promise<void> {
  fireEvent.click(screen.getByText("Regenerate recovery codes"));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByText("Make new codes"));
}

describe("AdminAccountSecurity", () => {
  it("calls the endpoint with the code and shows the returned codes once", async () => {
    regenerate.mockResolvedValue({ codes: ["AAAA-1111", "BBBB-2222"] });
    render(<AdminAccountSecurity />);
    await submit();
    await waitFor(() => expect(screen.getByText("AAAA-1111")).toBeTruthy());
    expect(regenerate).toHaveBeenCalledWith("123456");
    expect(screen.getByText("BBBB-2222")).toBeTruthy();
    fireEvent.click(screen.getByText("I saved them"));
    expect(screen.queryByText("AAAA-1111")).toBeNull();
  });

  it("shows an error and no codes on a 401", async () => {
    regenerate.mockRejectedValue(new (AdminApiError as unknown as new (s: number, e: object) => Error)(401, { code: "INVALID_CODE", message: "bad" }));
    render(<AdminAccountSecurity />);
    await submit();
    await waitFor(() => expect(screen.getByText(/not correct/)).toBeTruthy());
    expect(screen.queryByText("I saved them")).toBeNull();
  });

  it("shows an enrol link instead of the button without TOTP", () => {
    enrolled = false;
    render(<AdminAccountSecurity />);
    expect(screen.queryByText("Regenerate recovery codes")).toBeNull();
    expect(screen.getByText("Set up two-factor sign-in").getAttribute("href")).toBe("/admin/mfa");
  });
});
