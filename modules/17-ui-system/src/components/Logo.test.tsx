import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Logo } from "./Logo";

describe("Logo", () => {
  it("renders a home link when href is set", () => {
    render(<Logo href="/" />);
    const link = screen.getByRole("link", { name: "AssessIQ home" });
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveClass("aiq-mark");
  });

  it("renders no link without href", () => {
    render(<Logo />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("img", { name: "AssessIQ" })).toBeInTheDocument();
  });
});
