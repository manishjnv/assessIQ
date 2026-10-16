// RW-61: BlueprintBuilder maps a picked subject node to its domain.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {},
  listDomainsApi: async () => ({
    items: [{ id: "d1", slug: "sci", name: "Science set", description: null, status: "active", display_order: 1, node_id: "n1" }],
    total: 1,
  }),
  listCategoriesApi: async () => ({ items: [], total: 0 }),
}));
vi.mock("../api/frameworks.js", () => ({
  listFrameworksApi: async () => ({ items: [{ id: "f1", slug: "x", name: "Fw", source: "seed", status: "active", tenant_id: null }] }),
  listFrameworkNodesApi: async () => ({
    items: [
      { id: "n1", parent_id: null, kind: "subject", code: "SCI", label: "Science", position: 0, status: "active" },
      { id: "n2", parent_id: null, kind: "subject", code: "ART", label: "Art", position: 1, status: "active" },
    ],
  }),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { BlueprintBuilder } from "../pages/assessments/BlueprintBuilder.js";

afterEach(cleanup);

describe("BlueprintBuilder framework pick", () => {
  it("sets the matching domain, and notes when none matches", async () => {
    render(<BlueprintBuilder onBlueprintChange={() => {}} entitledDomains={null} skipFilter />);
    const select = (await screen.findByDisplayValue("— Select subject —")) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Science/ }));
    await waitFor(() => expect(select.value).toBe("d1"));
    expect(screen.queryByText("No question set uses this node yet.")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Science/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Art/ }));
    expect(await screen.findByText("No question set uses this node yet.")).toBeTruthy();
  });
});
