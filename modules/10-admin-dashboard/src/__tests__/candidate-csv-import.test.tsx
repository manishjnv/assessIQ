// CandidateCsvImport — preview → confirm → result flow (adminApi mocked).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const adminApi = vi.fn();
vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, e: { code: string; message: string }) {
      super(e.message);
      this.apiError = e;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { CandidateCsvImport, previewCsv } from "../components/CandidateCsvImport.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function pick(text: string) {
  const file = new File([text], "people.csv", { type: "text/csv" });
  // jsdom File.text() may be missing in older builds — shim it.
  if (typeof file.text !== "function") (file as unknown as { text: () => Promise<string> }).text = async () => text;
  fireEvent.change(screen.getByTestId("csv-file-input"), { target: { files: [file] } });
}

describe("previewCsv", () => {
  it("handles BOM, header case, quoted commas, and caps preview at 10", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `"Doe, ${i}",u${i}@x.com`).join("\n");
    const p = previewCsv("﻿Email,NAME\n" + "a@x.com,A\n" + rows);
    expect(p.total).toBe(13);
    expect(p.rows).toHaveLength(10);
    expect(p.rows[0]).toEqual(["A", "a@x.com"]);
  });
  it("flags a missing header", () => {
    expect(previewCsv("foo,bar\n1,2").total).toBe(-1);
  });
});

describe("CandidateCsvImport", () => {
  it("previews, posts csv + assessment_id on confirm, shows summary + skipped + warning, refreshes", async () => {
    adminApi.mockResolvedValue({
      created: 1,
      existing: 0,
      invited: 1,
      skipped: [{ row: 3, email: "bad", reason: "INVALID_EMAIL" }],
      warning: "Email plan sends ~300/day shared; some invites may be delayed",
    });
    const onImported = vi.fn();
    render(<CandidateCsvImport assessmentId="as1" onImported={onImported} />);

    pick("name,email\nAsha,asha@example.com\nBad,bad");
    await screen.findByText(/2 rows/);
    expect(adminApi).not.toHaveBeenCalled(); // nothing sent before Confirm

    fireEvent.click(screen.getByRole("button", { name: /Import and invite 2/ }));
    await screen.findByText("1 created");
    expect(adminApi).toHaveBeenCalledWith("/admin/users/import", {
      method: "POST",
      body: JSON.stringify({ csv: "name,email\nAsha,asha@example.com\nBad,bad", assessment_id: "as1" }),
    });
    expect(screen.getByText("1 skipped")).toBeTruthy();
    expect(screen.getByText(/Row 3: bad — INVALID_EMAIL/)).toBeTruthy();
    expect(screen.getByText(/300\/day/)).toBeTruthy();
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("rejects a file without name/email header client-side", async () => {
    render(<CandidateCsvImport assessmentId="as1" onImported={vi.fn()} />);
    pick("foo,bar\n1,2");
    await screen.findByRole("alert");
    expect(adminApi).not.toHaveBeenCalled();
  });
});
