import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("renders the spinner element with default size", () => {
    const { container } = render(<Spinner />);
    const el = container.querySelector(".aiq-spinner");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("aria-label", "Loading");
  });

  it("applies size variant class for sm", () => {
    const { container } = render(<Spinner size="sm" />);
    expect(container.querySelector(".aiq-spinner-sm")).toBeInTheDocument();
  });

  it("applies size variant class for lg", () => {
    const { container } = render(<Spinner size="lg" />);
    expect(container.querySelector(".aiq-spinner-lg")).toBeInTheDocument();
  });

  it("respects custom aria-label", () => {
    const { container } = render(<Spinner aria-label="Submitting" />);
    expect(container.querySelector(".aiq-spinner")).toHaveAttribute("aria-label", "Submitting");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Spinner />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
