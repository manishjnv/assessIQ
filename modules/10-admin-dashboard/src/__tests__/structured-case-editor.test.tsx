import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
vi.mock("@assessiq/help-system/components", () => ({ HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { EMPTY_SC, StructuredCaseEditor, buildStructuredCaseContent, passageSetPreset, structuredCaseError, type ScState } from "../components/StructuredCaseEditor.js";

let latest: ScState = EMPTY_SC;
function Host(): React.ReactElement {
  const [v, setV] = useState<ScState>(EMPTY_SC);
  latest = v;
  return <StructuredCaseEditor value={v} onChange={setV} />;
}

describe("StructuredCaseEditor EX-3", () => {
  it("preset fills 5 select-one steps with 4 options", () => {
    render(<Host />);
    fireEvent.click(screen.getByText(/Passage set preset/));
    expect(latest.steps).toHaveLength(5);
    expect(latest.steps.every((s) => s.select === "one" && s.options.length === 4 && s.points === "1")).toBe(true);
    expect(screen.getByLabelText("Step 5 marks")).toBeTruthy();
  });
  it("marks inputs round-trip into content JSON; blank omits keys", () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText("Step 1 marks"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Step 1 negative marks"), { target: { value: "0.5" } });
    const c = buildStructuredCaseContent({ ...latest, title: "t", context: "c" }) as { steps: Array<Record<string, unknown>> };
    expect(c.steps[0]).toMatchObject({ points: 2, negative_marks: 0.5 });
    const blank = buildStructuredCaseContent({ ...EMPTY_SC, title: "t", context: "c" }) as { steps: Array<Record<string, unknown>> };
    expect("points" in blank.steps[0]!).toBe(false);
    expect(structuredCaseError({ ...passageSetPreset(), steps: [{ ...passageSetPreset().steps[0]!, prompt: "p", options: ["a", "b"], points: "-1" }] })).toMatch(/marks/);
  });
});
