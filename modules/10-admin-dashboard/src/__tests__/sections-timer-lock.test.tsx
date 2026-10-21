// Z-131: admin controls for `locked` (FUT-4) and `seconds_per_question` (FUT-7) on a section.
// The lock switch shows only with a whole-test time; both keys are written only when set.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  listDomainsApi: () => Promise.resolve({ items: [] }),
  listCategoriesApi: () => Promise.resolve({ items: [] }),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionsCard } from "../components/SectionsCard.js";
import { SectionsEditor, buildSections, NEW_SECTION_ROW, TIMER_LOCK_NOTE } from "../pages/SectionsEditor.js";
import type { SectionRow } from "../pages/SectionsEditor.js";

const row = (patch: Partial<SectionRow> = {}): SectionRow => ({
  ...NEW_SECTION_ROW,
  name: "Quant",
  count: "5",
  minutes: "10",
  ...patch,
});

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("SectionsEditor lock switch (Z-131)", () => {
  it("shows the lock switch only when a whole-test time is set", () => {
    const { rerender } = render(<SectionsEditor rows={[row()]} onChange={vi.fn()} />);
    expect(screen.queryByRole("switch", { name: "Section 1 lock after leaving" })).toBeNull();
    rerender(<SectionsEditor rows={[row()]} onChange={vi.fn()} wholeTestMinutes={60} />);
    expect(screen.getByRole("switch", { name: "Section 1 lock after leaving" })).toBeTruthy();
  });

  it("always shows the seconds per question field, and the take page note", () => {
    render(<SectionsEditor rows={[row()]} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Section 1 seconds per question")).toBeTruthy();
    expect(screen.getByText(TIMER_LOCK_NOTE)).toBeTruthy();
  });
});

describe("buildSections for locked and seconds_per_question (Z-131)", () => {
  it("writes neither key for an untouched section", () => {
    const built = buildSections([row()]);
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.settings.sections).toEqual([{ name: "Quant", minutes: 10, question_count: 5 }]);
    expect(JSON.stringify(built.settings)).not.toMatch(/locked|seconds_per_question/);
  });

  it("writes both keys when set", () => {
    const built = buildSections([row({ locked: true, secondsPerQuestion: "30" })]);
    if ("error" in built) throw new Error(built.error);
    expect(built.settings.sections[0]).toMatchObject({ locked: true, seconds_per_question: 30 });
  });

  it.each([
    ["9", "from 10 to 3600"],
    ["3601", "from 10 to 3600"],
    ["12.5", "from 10 to 3600"],
  ])("rejects seconds per question %s with a plain message", (value, text) => {
    const built = buildSections([row({ secondsPerQuestion: value })]);
    expect("error" in built && built.error).toContain(text);
  });

  it("accepts the range ends and treats blank as none", () => {
    for (const value of ["10", "3600", ""]) {
      expect("error" in buildSections([row({ secondsPerQuestion: value })])).toBe(false);
    }
  });
});

describe("SectionsCard round trip (Z-131)", () => {
  it("shows saved values on edit and sends them back unchanged", async () => {
    const settings = {
      whole_test_minutes: 60,
      sections: [{ name: "Quant", question_count: 5, minutes: 10, locked: true, seconds_per_question: 30 }],
    };
    adminApi.mockResolvedValueOnce({ settings }).mockResolvedValueOnce({});
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    expect((screen.getByRole("switch", { name: "Section 1 lock after leaving" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Section 1 seconds per question") as HTMLInputElement).value).toBe("30");
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    await waitFor(() => expect(adminApi).toHaveBeenCalledTimes(2));
    const body = JSON.parse((adminApi.mock.calls[1] as [string, { body: string }])[1].body);
    expect(body.settings.whole_test_minutes).toBe(60);
    expect(body.settings.sections).toEqual([
      { name: "Quant", question_count: 5, minutes: 10, locked: true, seconds_per_question: 30 },
    ]);
  });

  it("sends no new keys when the editor is saved untouched", async () => {
    const settings = { sections: [{ name: "Quant", question_count: 5, minutes: 10 }] };
    adminApi.mockResolvedValueOnce({ settings }).mockResolvedValueOnce({});
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    await waitFor(() => expect(adminApi).toHaveBeenCalledTimes(2));
    const raw = (adminApi.mock.calls[1] as [string, { body: string }])[1].body;
    expect(JSON.parse(raw).settings.sections).toEqual([{ name: "Quant", question_count: 5, minutes: 10 }]);
    expect(raw).not.toMatch(/locked|seconds_per_question/);
  });

  it("shows the range message and does not call the server", async () => {
    const settings = { sections: [{ name: "Quant", question_count: 5, minutes: 10 }] };
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    fireEvent.change(screen.getByLabelText("Section 1 seconds per question"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    expect(screen.getByRole("alert").textContent).toContain("seconds per question must be a whole number from 10 to 3600.");
    expect(adminApi).not.toHaveBeenCalled();
  });
});
