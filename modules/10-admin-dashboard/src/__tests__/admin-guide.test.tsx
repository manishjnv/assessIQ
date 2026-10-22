// S16 — /admin/guide renders its steps, tips and FAQ from the help API (admin.guide.*).
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const entries = new Map<string, { shortText: string; longMd: string }>([
  ["admin.guide.step_01", { shortText: "Find your licensed sets", longMd: "Click **Question bank** in the sidebar." }],
  ["admin.guide.step_08", { shortText: "Invite candidates", longMd: "- one\n- two" }],
  ["admin.guide.tip_audit_log", { shortText: "Audit log", longMd: "Export as CSV or JSONL.\n" }],
  ["admin.guide.faq_retake", { shortText: "Can a candidate retake?", longMd: "Not by default.\n" }],
]);

vi.mock("@assessiq/help-system/components", () => ({
  HelpProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useHelpContext: () => ({ entries, loading: false, error: null }),
}));

import { AdminGuide } from "../pages/admin-guide.js";

describe("AdminGuide", () => {
  it("renders help-API content", () => {
    render(<MemoryRouter><AdminGuide /></MemoryRouter>);
    expect(screen.getAllByText(/Find your licensed sets/).length).toBeGreaterThan(0);
    expect(screen.getByText("Question bank").tagName).toBe("STRONG");
    expect(screen.getByText("two").tagName).toBe("LI");
    expect(screen.getByText("Export as CSV or JSONL.")).toBeTruthy();
    expect(screen.getByText("Can a candidate retake?")).toBeTruthy();
    expect(screen.getByText("Open Users →")).toBeTruthy();
  });
});
