// SectionsEditor: "Categories from" follows the chosen set's subject (Z-124).
// Locked to the set's subject when one is given; hidden with no set or no categories;
// ticked categories clear when the set changes, and are kept on mount.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { listCategoriesApi } = vi.hoisted(() => ({ listCategoriesApi: vi.fn() }));

vi.mock("../api.js", () => ({
  listDomainsApi: () =>
    Promise.resolve({
      items: [
        { id: "d-apt", slug: "aptitude", name: "Aptitude", description: null, status: "active", display_order: 1 },
        { id: "d-phish", slug: "phishing", name: "Phishing", description: null, status: "active", display_order: 2 },
        { id: "d-empty", slug: "empty", name: "Empty", description: null, status: "active", display_order: 3 },
      ],
      total: 3,
    }),
  listCategoriesApi: (...a: unknown[]) => listCategoriesApi(...a),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionsEditor, NEW_SECTION_ROW } from "../pages/SectionsEditor.js";
import type { SectionRow } from "../pages/SectionsEditor.js";

const cat = (id: string, name: string, domain_id: string) => ({
  id, domain_id, slug: id, name, description: null, relevance_score: 1, status: "active",
});

const aptRow = (categoryIds: string[] = []): SectionRow => ({ ...NEW_SECTION_ROW, name: "Quant", count: "5", minutes: "10", categoryIds });

beforeEach(() => {
  listCategoriesApi.mockReset();
  listCategoriesApi.mockImplementation((domainId: string) =>
    Promise.resolve({
      items:
        domainId === "d-apt"
          ? [cat("c-num", "Numerical", "d-apt"), cat("c-verb", "Verbal", "d-apt")]
          : domainId === "d-phish"
            ? [cat("c-mail", "Email", "d-phish")]
            : [],
      total: 0,
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe("SectionsEditor subject lock (Z-124)", () => {
  it("preselects and locks the set's subject, and lists only its categories", async () => {
    render(<SectionsEditor rows={[aptRow()]} onChange={vi.fn()} subjectSlug="aptitude" setId="s1" />);
    const select = (await screen.findByLabelText("Subject for category choices")) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("d-apt");
    expect(select.options).toHaveLength(1);
    expect(select.options[0]?.textContent).toBe("Aptitude");
    expect(await screen.findByLabelText("Numerical")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    await waitFor(() => expect(listCategoriesApi).toHaveBeenCalledWith("d-apt"));
    expect(listCategoriesApi).not.toHaveBeenCalledWith("d-phish");
  });

  it("hides the dropdown and loads no categories when no set is chosen", async () => {
    render(<SectionsEditor rows={[aptRow()]} onChange={vi.fn()} subjectSlug={null} setId={null} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText("Subject for category choices")).toBeNull();
    expect(screen.queryByText(/Categories from/)).toBeNull();
    expect(listCategoriesApi).not.toHaveBeenCalled();
  });

  it("hides the dropdown when the set's subject has no category", async () => {
    render(<SectionsEditor rows={[aptRow()]} onChange={vi.fn()} subjectSlug="empty" setId="s9" />);
    await waitFor(() => expect(listCategoriesApi).toHaveBeenCalledWith("d-empty"));
    expect(screen.queryByLabelText("Subject for category choices")).toBeNull();
  });

  it("clears ticked categories when the set changes", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SectionsEditor rows={[aptRow(["c-num"])]} onChange={onChange} subjectSlug="aptitude" setId="s1" />,
    );
    await screen.findByLabelText("Numerical");
    expect(onChange).not.toHaveBeenCalled(); // mount keeps the saved ticks
    rerender(<SectionsEditor rows={[aptRow(["c-num"])]} onChange={onChange} subjectSlug="aptitude" setId="s2" />);
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ categoryIds: [] })]);
  });

  it("the free picker (no subject given) keeps the old 'none' option", async () => {
    render(<SectionsEditor rows={[aptRow()]} onChange={vi.fn()} />);
    const select = (await screen.findByLabelText("Subject for category choices")) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.options[0]?.textContent).toMatch(/none/);
    fireEvent.change(select, { target: { value: "d-phish" } });
    await waitFor(() => expect(listCategoriesApi).toHaveBeenCalledWith("d-phish"));
  });
});
