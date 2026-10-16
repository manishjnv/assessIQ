// RW-61: FrameworkTreePicker + question editor / blueprint integrations.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const nodesApi = vi.fn();
vi.mock("../api/frameworks.js", () => ({
  listFrameworksApi: async () => ({ items: [{ id: "f1", slug: "cbse", name: "CBSE", source: "seed", status: "active", tenant_id: null }] }),
  listFrameworkNodesApi: (...a: unknown[]) => nodesApi(...a),
}));

import { FrameworkTreePicker } from "../components/FrameworkTreePicker.js";

const NODES = [
  { id: "n1", parent_id: null, kind: "subject", code: "SCI", label: "Science", position: 0, status: "active" },
  { id: "n2", parent_id: "n1", kind: "unit", code: "U1", label: "Photosynthesis", position: 0, status: "active" },
  { id: "n3", parent_id: null, kind: "subject", code: "MAT", label: "Maths", position: 1, status: "active" },
];

afterEach(() => { cleanup(); nodesApi.mockReset(); });

function setup(props: Partial<React.ComponentProps<typeof FrameworkTreePicker>> = {}) {
  nodesApi.mockResolvedValue({ items: NODES });
  const onChange = vi.fn();
  render(<FrameworkTreePicker frameworkId="f1" value={[]} onChange={onChange} multiple helpId="x.y" {...props} />);
  return onChange;
}

describe("FrameworkTreePicker", () => {
  it("renders roots only and expands children lazily", async () => {
    setup();
    expect(await screen.findByText("Science")).toBeTruthy();
    expect(screen.queryByText("Photosynthesis")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Science" }));
    expect(screen.getByText("Photosynthesis")).toBeTruthy();
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.getAllByRole("treeitem")[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("search filters and auto-expands ancestors", async () => {
    setup();
    await screen.findByText("Science");
    fireEvent.change(screen.getByLabelText("Search framework nodes"), { target: { value: "photo" } });
    expect(screen.getByText("Photosynthesis")).toBeTruthy();
    expect(screen.getByText("Science")).toBeTruthy();
    expect(screen.queryByText("Maths")).toBeNull();
  });

  it("fires onChange with ids and nodes", async () => {
    const onChange = setup();
    await screen.findByText("Maths");
    fireEvent.click(screen.getByRole("checkbox", { name: /Maths/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(["n3"]);
    expect(onChange.mock.calls[0]![1][0].label).toBe("Maths");
  });

  it("readOnly disables checkboxes", async () => {
    setup({ readOnly: true });
    await screen.findByText("Maths");
    for (const c of screen.getAllByRole("checkbox")) expect((c as HTMLInputElement).disabled).toBe(true);
  });

  it("Enter on a treeitem toggles it and kinds limits selection", async () => {
    setup({ kinds: ["subject"] });
    await screen.findByText("Science");
    fireEvent.keyDown(screen.getAllByRole("treeitem")[0]!, { key: "Enter" });
    expect(screen.getByText("Photosynthesis")).toBeTruthy();
    // unit is not selectable: only the two subject checkboxes exist
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("shows the framework select when no frameworkId", async () => {
    nodesApi.mockResolvedValue({ items: NODES });
    render(<FrameworkTreePicker value={[]} onChange={vi.fn()} helpId="x.y" />);
    expect(await screen.findByLabelText("Framework")).toBeTruthy();
    await waitFor(() => expect(nodesApi).toHaveBeenCalledWith("f1"));
  });
});
