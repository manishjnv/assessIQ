// EXP-36: "Add to an existing question set" picker on the import screens.
// Lists the organisation's non-archived sets of the chosen subject. A chosen set adds the level picker.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React, { useState } from "react";

const { listTenantPacksApi, getPackLevelsApi } = vi.hoisted(() => ({
  listTenantPacksApi: vi.fn(),
  getPackLevelsApi: vi.fn(),
}));

vi.mock("../api.js", () => ({
  listTenantPacksApi: (...a: unknown[]) => listTenantPacksApi(...a),
  getPackLevelsApi: (...a: unknown[]) => getPackLevelsApi(...a),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { ImportTargetPicker, NO_IMPORT_TARGET, type ImportTarget } from "../components/ImportTargetPicker.js";

// A harness keeps the value in state, as the import pages do.
function Harness({ domain, onSpy }: { domain: string; onSpy: (t: ImportTarget) => void }): React.ReactElement {
  const [value, setValue] = useState<ImportTarget>(NO_IMPORT_TARGET);
  return (
    <ImportTargetPicker
      domain={domain}
      value={value}
      helpId="admin.question_import.target_pack"
      idPrefix="t"
      onChange={(next) => { setValue(next); onSpy(next); }}
    />
  );
}

beforeEach(() => {
  listTenantPacksApi.mockReset();
  getPackLevelsApi.mockReset();
  listTenantPacksApi.mockResolvedValue({
    packs: [
      { id: "p-alpha", name: "Alpha set", domain: "security", status: "published" },
      { id: "p-old", name: "Old set", domain: "security", status: "archived" },
      { id: "p-maths", name: "Maths set", domain: "maths", status: "draft" },
    ],
  });
  getPackLevelsApi.mockResolvedValue({ levels: [{ id: "l2", order: 2 }, { id: "l1", order: 1 }] });
});

afterEach(() => {
  cleanup();
});

describe("ImportTargetPicker (EXP-36)", () => {
  it("lists only non-archived sets of the chosen subject", async () => {
    render(<Harness domain="security" onSpy={vi.fn()} />);
    const select = (await screen.findByLabelText(/Add to an existing question set/)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["No. Create a new question set.", "Alpha set"]);
  });

  it("is disabled until a subject is chosen", () => {
    render(<Harness domain="" onSpy={vi.fn()} />);
    const select = document.getElementById("t-pack") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByText("Choose a subject first.")).toBeTruthy();
  });

  it("choosing a set loads its levels and shows the level picker", async () => {
    const onSpy = vi.fn();
    render(<Harness domain="security" onSpy={onSpy} />);
    const select = await screen.findByRole("option", { name: "Alpha set" });
    fireEvent.change(document.getElementById("t-pack") as HTMLSelectElement, { target: { value: "p-alpha" } });
    expect(onSpy).toHaveBeenLastCalledWith({ packId: "p-alpha", levelPosition: null });
    await waitFor(() => expect(getPackLevelsApi).toHaveBeenCalledWith("p-alpha"));
    const level = (await screen.findByLabelText("Level")) as HTMLSelectElement;
    const labels = Array.from(level.options).map((o) => o.textContent);
    expect(labels).toEqual(["From each row's level column", "Level 1", "Level 2"]);
    expect(select).toBeTruthy();
  });

  it("a chosen level is sent as its position", async () => {
    const onSpy = vi.fn();
    render(<Harness domain="security" onSpy={onSpy} />);
    await screen.findByRole("option", { name: "Alpha set" });
    fireEvent.change(document.getElementById("t-pack") as HTMLSelectElement, { target: { value: "p-alpha" } });
    const level = (await screen.findByLabelText("Level")) as HTMLSelectElement;
    await waitFor(() => expect(level.options.length).toBe(3));
    fireEvent.change(level, { target: { value: "2" } });
    expect(onSpy).toHaveBeenLastCalledWith({ packId: "p-alpha", levelPosition: 2 });
  });

  it("creating a new set shows no level picker", async () => {
    render(<Harness domain="security" onSpy={vi.fn()} />);
    await screen.findByRole("option", { name: "Alpha set" });
    expect(screen.queryByLabelText("Level")).toBeNull();
    expect(getPackLevelsApi).not.toHaveBeenCalled();
  });
});
