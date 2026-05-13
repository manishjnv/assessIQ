import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("renders track and fill with computed width", () => {
    const { container } = render(<ProgressBar value={60} label="Loading" />);
    const track = container.querySelector(".aiq-progress-bar");
    const fill = container.querySelector(".aiq-progress-bar-fill") as HTMLElement;
    expect(track).toBeInTheDocument();
    expect(track).toHaveAttribute("role", "progressbar");
    expect(track).toHaveAttribute("aria-valuenow", "60");
    expect(fill.style.width).toBe("60%");
  });

  it("clamps value below 0 to 0%", () => {
    const { container } = render(<ProgressBar value={-25} label="x" />);
    expect((container.querySelector(".aiq-progress-bar-fill") as HTMLElement).style.width).toBe("0%");
  });

  it("clamps value above max to 100%", () => {
    const { container } = render(<ProgressBar value={250} max={100} label="x" />);
    expect((container.querySelector(".aiq-progress-bar-fill") as HTMLElement).style.width).toBe("100%");
  });

  it("emits data-variant only for non-default variants", () => {
    const { container: defaultC } = render(<ProgressBar value={50} label="x" />);
    expect(defaultC.querySelector(".aiq-progress-bar-fill")).not.toHaveAttribute("data-variant");
    const { container: successC } = render(<ProgressBar value={50} variant="success" label="x" />);
    expect(successC.querySelector(".aiq-progress-bar-fill")).toHaveAttribute("data-variant", "success");
  });

  it("emits data-height only for non-default heights", () => {
    const { container: defaultC } = render(<ProgressBar value={50} label="x" />);
    expect(defaultC.querySelector(".aiq-progress-bar")).not.toHaveAttribute("data-height");
    const { container: tallC } = render(<ProgressBar value={50} height={6} label="x" />);
    expect(tallC.querySelector(".aiq-progress-bar")).toHaveAttribute("data-height", "6");
  });

  it("has no axe violations", async () => {
    const { container } = render(<ProgressBar value={60} label="Loading" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
