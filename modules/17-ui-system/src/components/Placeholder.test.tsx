import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Placeholder } from "./Placeholder";

describe("Placeholder", () => {
  it("renders the default caption 'image'", () => {
    const { container, getByText } = render(<Placeholder />);
    const el = container.querySelector(".aiq-placeholder") as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("role", "img");
    expect(el).toHaveAttribute("aria-label", "image");
    expect(getByText("image")).toBeInTheDocument();
  });

  it("uses the provided caption", () => {
    const { container, getByText } = render(<Placeholder caption="diagram pending" />);
    expect(container.querySelector(".aiq-placeholder")).toHaveAttribute("aria-label", "diagram pending");
    expect(getByText("diagram pending")).toBeInTheDocument();
  });

  it("applies width and height via inline style", () => {
    const { container } = render(<Placeholder width={320} height={180} />);
    const el = container.querySelector(".aiq-placeholder") as HTMLElement;
    expect(el.style.width).toBe("320px");
    expect(el.style.height).toBe("180px");
  });

  it("applies radius override when provided", () => {
    const { container } = render(<Placeholder radius={4} />);
    expect((container.querySelector(".aiq-placeholder") as HTMLElement).style.borderRadius).toBe("4px");
  });

  it("lets consumer style overrides win", () => {
    const { container } = render(<Placeholder width={100} style={{ width: 240 }} />);
    expect((container.querySelector(".aiq-placeholder") as HTMLElement).style.width).toBe("240px");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Placeholder caption="diagram" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
