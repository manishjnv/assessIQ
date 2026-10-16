// FR1 / FU-B2: audit page export JSONL link carries the filters; archive confirm -> POST -> note.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("../api.js", () => ({ adminApi: vi.fn() }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/PageHeader.js", () => ({
  PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement("div", null, actions),
}));
vi.mock("@assessiq/ui-system", () => ({
  Button: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = p;
    return React.createElement("button", rest, children);
  },
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => React.createElement("input", p),
  Spinner: () => React.createElement("div", { role: "status" }, "Loading"),
  Table: () => React.createElement("div", null, "table"),
  formatDateTime: (s: string) => s,
  ConfirmDialog: ({ open, body, confirmLabel, onConfirm }: { open: boolean; body: React.ReactNode; confirmLabel: string; onConfirm: () => void }) =>
    open ? React.createElement("div", { role: "dialog" }, body, React.createElement("button", { onClick: onConfirm }, confirmLabel)) : null,
}));

import { adminApi } from "../api.js";
import AuditLogPage from "../pages/audit-log.js";

const list = { rows: [], total: 0, page: 1, pageSize: 50 };

beforeEach(() => {
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path: string) => {
    if (path.startsWith("/admin/audit/archive")) {
      return { archive_id: "a1", row_count: 100000, truncated: true, export_url: "/api/admin/audit/export.jsonl?x=1" } as never;
    }
    return list as never;
  });
});
afterEach(cleanup);
vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); // no real navigation in jsdom

describe("audit log export and archive", () => {
  it("the JSONL link carries the date filters", async () => {
    render(<AuditLogPage />);
    await waitFor(() => expect(screen.getByText("Export JSONL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });
    const href = screen.getByText("Export JSONL").getAttribute("href")!;
    expect(href).toContain("/api/admin/audit/export.jsonl?");
    expect(href).toContain("from=");
  });

  it("archive confirm posts the range and shows the count and the cap note", async () => {
    render(<AuditLogPage />);
    await waitFor(() => expect(screen.getByText("Archive range")).toBeTruthy());
    expect((screen.getByText("Archive range") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-02-01" } });
    fireEvent.click(screen.getByText("Archive range"));
    expect(screen.getByRole("dialog").textContent).toContain("From 2026-01-01 to 2026-02-01");
    fireEvent.click(screen.getByText("Archive and download"));
    await waitFor(() => expect(screen.getByText("100000 rows marked as archived")).toBeTruthy());
    const call = vi.mocked(adminApi).mock.calls.find((c) => String(c[0]).startsWith("/admin/audit/archive"))!;
    expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ format: "jsonl" });
    expect(screen.getByText(/covers the first 100,000 rows/)).toBeTruthy();
  });
});
