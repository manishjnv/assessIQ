// ResultReleaseCard (per-assessment release override) and the SP11 ETA notice in ReleaseResendBlock.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { ResultReleaseCard } from "../components/ResultReleaseCard.js";
import { ReleaseResendBlock, type ReleaseResendBlockProps } from "../pages/assessment-detail/ReleaseResendBlock.js";
import { AdminApiError } from "../api.js";

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("ResultReleaseCard", () => {
  it("shows the three plain-word options and starts on the organisation default", () => {
    render(<ResultReleaseCard assessmentId="as-1" />);
    const select = screen.getByLabelText("Result release") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Use organisation default",
      "Release automatically",
      "Admin releases manually",
    ]);
  });

  it("shows the saved override", () => {
    render(<ResultReleaseCard assessmentId="as-1" initial="manual" />);
    expect((screen.getByLabelText("Result release") as HTMLSelectElement).value).toBe("manual");
  });

  it("PATCHes only result_release_mode; the default option sends null", async () => {
    adminApi.mockResolvedValue({});
    render(<ResultReleaseCard assessmentId="as-1" initial="auto" />);
    fireEvent.click(screen.getByRole("button", { name: "Save result release" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
    expect(adminApi).toHaveBeenCalledWith("/admin/assessments/as-1/result-release", {
      method: "PATCH",
      body: JSON.stringify({ result_release_mode: "auto" }),
    });

    fireEvent.change(screen.getByLabelText("Result release"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save result release" }));
    await waitFor(() => expect(adminApi).toHaveBeenCalledTimes(2));
    expect(adminApi).toHaveBeenLastCalledWith("/admin/assessments/as-1/result-release", {
      method: "PATCH",
      body: JSON.stringify({ result_release_mode: null }),
    });
  });

  it("shows the server message when the save fails", async () => {
    adminApi.mockRejectedValue(new AdminApiError(404, { code: "NOT_FOUND", message: "Assessment not found" } as never));
    render(<ResultReleaseCard assessmentId="as-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Save result release" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Assessment not found"));
  });
});

function blockProps(over: Partial<ReleaseResendBlockProps> = {}): ReleaseResendBlockProps {
  return {
    assessment: {
      id: "as-1",
      name: "A",
      status: "active",
      pack_id: "p",
      opens_at: null,
      closes_at: null,
      created_at: "2026-10-01T00:00:00Z",
      camera_required: false,
      evaluation_turnaround_text: "within 72 hours",
    },
    hasAttempts: true,
    publishingAll: false,
    setPublishAllError: vi.fn(),
    setShowPublishAll: vi.fn(),
    publishAllResult: null,
    publishAllError: null,
    showPublishAll: false,
    handlePublishAll: vi.fn(async () => undefined),
    showResendAll: false,
    setShowResendAll: vi.fn(),
    resendingAll: false,
    resendable: 0,
    handleResendAll: vi.fn(async () => undefined),
    ...over,
  };
}

const renderBlock = (over: Partial<ReleaseResendBlockProps> = {}) =>
  render(
    <MemoryRouter>
      <ReleaseResendBlock {...blockProps(over)} />
    </MemoryRouter>,
  );

describe("ReleaseResendBlock — SP11 ETA notice", () => {
  it("shows the approved wording with the configured turnaround", () => {
    renderBlock({ showEtaNotice: true });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(
      "Results are not released yet. Expect grading within 72 hours. Results stay hidden until you release them.",
    );
    expect(notice.getAttribute("data-help-id")).toBe("admin.assessments.release_notice");
  });

  it("uses the config text as given", () => {
    renderBlock({
      showEtaNotice: true,
      assessment: { ...blockProps().assessment, evaluation_turnaround_text: "within 2 working days" },
    });
    expect(screen.getByRole("status").textContent).toContain("Expect grading within 2 working days. Results stay hidden");
  });

  it("is hidden when there is nothing submitted, or a result is already released", () => {
    renderBlock({ showEtaNotice: false });
    expect(screen.queryByText("Results are not released yet.")).toBeNull();
  });

  it("is hidden when the server did not send the turnaround text", () => {
    const { evaluation_turnaround_text: _drop, ...rest } = blockProps().assessment;
    renderBlock({ showEtaNotice: true, assessment: rest });
    expect(screen.queryByText("Results are not released yet.")).toBeNull();
  });
});
