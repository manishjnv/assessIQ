// Z-143 TestTypeChooser: keyboard, ARIA, disabled states, readOnly, axe.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React, { useState } from "react";
import { axe } from "vitest-axe";

vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TestTypeChooser, type TestType, type ChooserCameraSettings } from "../components/TestTypeChooser.js";

const ON: ChooserCameraSettings = { isSchool: false, cameraEnabled: true, cameraEnforced: true };

function Harness({ initial = "real", camera = ON, readOnly = false }: { initial?: TestType; camera?: ChooserCameraSettings | null; readOnly?: boolean }) {
  const [v, setV] = useState<TestType>(initial);
  const [i, setI] = useState({ fullscreen: false, blockCopyPaste: false });
  return <TestTypeChooser value={v} onChange={setV} integrity={i} onIntegrityChange={setI} cameraSettings={camera} readOnly={readOnly} />;
}
const radios = () => screen.getAllByRole("radio");

afterEach(() => cleanup());

describe("TestTypeChooser", () => {
  it("defaults to Real, with a roving tab stop on the checked card", () => {
    render(<Harness />);
    const [mock, real, cam] = radios();
    expect(real!.getAttribute("aria-checked")).toBe("true");
    expect(mock!.getAttribute("aria-checked")).toBe("false");
    expect([mock, real, cam].map((r) => r!.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole("radiogroup", { name: "Test type" })).toBeTruthy();
    expect(screen.getByText("Charged when the student submits, or when the time runs out.")).toBeTruthy();
  });

  it("arrow keys move and select, wrapping; Space selects the focused card", () => {
    render(<Harness />);
    const [mock, real, cam] = radios();
    real!.focus();
    fireEvent.keyDown(real!, { key: "ArrowRight" });
    expect(cam!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(cam);
    fireEvent.keyDown(cam!, { key: "ArrowRight" });
    expect(mock!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(mock!, { key: "ArrowLeft" });
    expect(cam!.getAttribute("aria-checked")).toBe("true");
    mock!.focus();
    fireEvent.keyDown(mock!, { key: " " });
    expect(mock!.getAttribute("aria-checked")).toBe("true");
  });

  it("click anywhere on a card selects it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("test-type-card-mock"));
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("Mock checkboxes are disabled unless Mock is selected; Real shows locked rows", () => {
    render(<Harness />);
    const box = screen.getByRole("checkbox", { name: "Require full screen" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getAllByText("Fixed: on").length).toBe(4);
    fireEvent.click(radios()[0]!);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it("school with the camera off disables the camera card with the exact text", () => {
    render(<Harness camera={{ isSchool: true, cameraEnabled: false, cameraEnforced: true }} />);
    const cam = radios()[2]!;
    expect(cam.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Your organisation turned the camera off. Turn it on in Settings to use this type.")).toBeTruthy();
    fireEvent.click(cam);
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios()[1]!, { key: "ArrowRight" });
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("cameraEnforced false disables the camera card", () => {
    render(<Harness camera={{ isSchool: false, cameraEnabled: true, cameraEnforced: false }} />);
    expect(radios()[2]!.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Camera is temporarily off.")).toBeTruthy();
  });

  it("readOnly shows only the chosen card and a Locked after publish chip", () => {
    render(<Harness initial="real_camera" readOnly />);
    expect(radios().length).toBe(1);
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Locked after publish")).toBeTruthy();
    fireEvent.keyDown(radios()[0]!, { key: "ArrowRight" });
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Charged when/)).toBeNull();
  });

  it("has no axe violations (editable and read-only)", async () => {
    const a = render(<main><Harness /></main>);
    expect((await axe(a.container)).violations).toEqual([]);
    cleanup();
    const b = render(<main><Harness initial="mock" readOnly /></main>);
    expect((await axe(b.container)).violations).toEqual([]);
  });
});
