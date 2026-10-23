// SectionsCard edit (Z-129): the category choices follow the assessment pack's subject.
// No packDomain (older response) keeps the old free picker.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { listCategoriesApi } = vi.hoisted(() => ({ listCategoriesApi: vi.fn() }));

vi.mock("../api.js", () => ({
  listTenantPacksApi: () => Promise.resolve({ packs: [] }),
  getPackLevelsApi: () => Promise.resolve({ levels: [] }),
  adminApi: vi.fn(),
  listDomainsApi: () =>
    Promise.resolve({
      items: [
        { id: "d-apt", slug: "aptitude", name: "Aptitude", description: null, status: "active", display_order: 1 },
        { id: "d-phish", slug: "phishing", name: "Phishing", description: null, status: "active", display_order: 2 },
      ],
      total: 2,
    }),
  listCategoriesApi: (...a: unknown[]) => listCategoriesApi(...a),
  AdminApiError: class AdminApiError extends Error {},
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionsCard } from "../components/SectionsCard.js";

const settings = { sections: [{ name: "Quant", question_count: 5, minutes: 10 }] };
const cat = (id: string, name: string, domain_id: string) => ({
  id, domain_id, slug: id, name, description: null, relevance_score: 1, status: "active",
});

beforeEach(() => {
  listCategoriesApi.mockReset();
  listCategoriesApi.mockImplementation((domainId: string) =>
    Promise.resolve({
      items:
        domainId === "d-apt"
          ? [cat("c-num", "Numerical", "d-apt")]
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

describe("SectionsCard subject lock (Z-129)", () => {
  it("shows only the pack subject's categories", async () => {
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft packDomain="aptitude" onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    const select = (await screen.findByLabelText("Subject for category choices")) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("d-apt");
    expect(await screen.findByLabelText("Numerical")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    await waitFor(() => expect(listCategoriesApi).toHaveBeenCalledWith("d-apt"));
    expect(listCategoriesApi).not.toHaveBeenCalledWith("d-phish");
  });

  it("keeps the free picker when the pack subject is absent", async () => {
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    const select = (await screen.findByLabelText("Subject for category choices")) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.options).toHaveLength(3);
  });
});
