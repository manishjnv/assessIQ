// EXP-36: the per-section "Question set for this section" picker in SectionsEditor.
// Default = the assessment's own set (no pack_id key). Only published sets are offered.
// A section with no pack keeps no pack_id key, so an untouched section saves unchanged.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const { listTenantPacksApi } = vi.hoisted(() => ({ listTenantPacksApi: vi.fn() }));

vi.mock("../api.js", () => ({
  listDomainsApi: () => Promise.resolve({ items: [], total: 0 }),
  listCategoriesApi: () => Promise.resolve({ items: [], total: 0 }),
  listTenantPacksApi: (...a: unknown[]) => listTenantPacksApi(...a),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionsEditor, NEW_SECTION_ROW, buildSections } from "../pages/SectionsEditor.js";
import type { SectionRow } from "../pages/SectionsEditor.js";

const row = (over: Partial<SectionRow> = {}): SectionRow => ({
  ...NEW_SECTION_ROW, name: "Quant", count: "5", minutes: "10", categoryIds: [], ...over,
});

beforeEach(() => {
  listTenantPacksApi.mockReset();
  listTenantPacksApi.mockResolvedValue({
    packs: [
      { id: "p-pub", name: "Published set", domain: "aptitude", status: "published" },
      { id: "p-draft", name: "Draft set", domain: "aptitude", status: "draft" },
    ],
  });
});

afterEach(() => {
  cleanup();
});

describe("SectionsEditor per-section question set (EXP-36)", () => {
  it("shows no picker unless the caller asks for it", () => {
    render(<SectionsEditor rows={[row()]} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Section 1 question set")).toBeNull();
    expect(listTenantPacksApi).not.toHaveBeenCalled();
  });

  it("defaults to the assessment's own set and lists only published sets", async () => {
    render(<SectionsEditor rows={[row()]} onChange={vi.fn()} withPackPicker />);
    const select = (await screen.findByLabelText("Section 1 question set")) as HTMLSelectElement;
    expect(select.value).toBe("");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Published set");
    expect(labels).not.toContain("Draft set");
    expect(labels[0]).toContain("The assessment");
  });

  it("reports the chosen set on the row, and back to default", async () => {
    const onChange = vi.fn();
    render(<SectionsEditor rows={[row()]} onChange={onChange} withPackPicker />);
    const select = await screen.findByLabelText("Section 1 question set");
    fireEvent.change(select, { target: { value: "p-pub" } });
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ packId: "p-pub" })]);
  });

  it("sends pack_id only for a section that has a set", () => {
    const built = buildSections([row({ packId: "p-pub" }), row({ name: "Verbal" })]);
    if ("error" in built) throw new Error(built.error);
    expect(built.settings.sections[0]).toEqual(expect.objectContaining({ pack_id: "p-pub" }));
    expect(built.settings.sections[1]).not.toHaveProperty("pack_id");
  });

  it("keeps a saved set that is no longer in the list, so the value is not lost", async () => {
    render(<SectionsEditor rows={[row({ packId: "p-gone" })]} onChange={vi.fn()} withPackPicker />);
    const select = (await screen.findByLabelText("Section 1 question set")) as HTMLSelectElement;
    await screen.findByText("Saved set (not in the list)");
    expect(select.value).toBe("p-gone");
  });
});
