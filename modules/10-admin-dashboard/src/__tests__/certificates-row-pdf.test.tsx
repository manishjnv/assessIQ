// AssessIQ — tests for the row-level PDF link on /admin/certificates (Z-11 item b).
//
//   P1  an active row shows a PDF link to the same URL as the drawer's Download PDF
//   P2  a revoked row shows no PDF link (the server returns 410 for revoked PDFs)
//   P3  clicking the PDF link does not open the details drawer

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: {
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" },
      tenant: { id: "t1", slug: "acme", name: "Acme College" },
      mfaStatus: "verified",
    },
    loading: false,
  }),
  fetchAdminWhoami: vi.fn().mockResolvedValue(null),
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AdminCertificates } from "../pages/certificates.js";

const ACTIVE_ID = "CERT-ACTIVE-0001";
const REVOKED_ID = "CERT-REVOKED-0002";

function row(credential_id: string, revoked_at: string | null) {
  return {
    id: `id-${credential_id}`,
    credential_id,
    candidate_id: "cand-1",
    user_email: "candidate@example.com",
    isErased: false,
    tier: "completion",
    course_title: "Security Basics",
    issued_at: "2026-10-01T10:00:00Z",
    revoked_at,
    revoke_reason: revoked_at ? "policy violation" : null,
    display_name: "Candidate One",
    level: "basic",
    pdf_downloads: 0,
  };
}

beforeEach(() => {
  adminApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/admin/certificates?")) {
      return {
        items: [row(ACTIVE_ID, null), row(REVOKED_ID, "2026-10-02T09:00:00Z")],
        total: 2,
      };
    }
    throw new Error(`unexpected path ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("certificates list — row PDF link", () => {
  it("P1: active row links to the same PDF URL as the drawer", async () => {
    render(<AdminCertificates />);
    await waitFor(() => expect(screen.getByText(ACTIVE_ID)).toBeTruthy());

    const links = screen.getAllByRole("link", { name: "PDF" });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(`/api/certificates/${ACTIVE_ID}/pdf`);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
  });

  it("P2: revoked row has no PDF link", async () => {
    render(<AdminCertificates />);
    await waitFor(() => expect(screen.getByText(REVOKED_ID)).toBeTruthy());

    const links = screen.queryAllByRole("link", { name: "PDF" });
    expect(links.every((a) => a.getAttribute("href") !== `/api/certificates/${REVOKED_ID}/pdf`)).toBe(true);
  });

  it("P3: clicking the PDF link does not open the details drawer", async () => {
    render(<AdminCertificates />);
    await waitFor(() => expect(screen.getByText(ACTIVE_ID)).toBeTruthy());

    fireEvent.click(screen.getByRole("link", { name: "PDF" }));
    expect(screen.queryByText("Certificate Details")).toBeNull();
  });
});
