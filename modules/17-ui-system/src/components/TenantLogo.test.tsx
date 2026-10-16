import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TenantLogo } from "./TenantLogo";

describe("TenantLogo", () => {
  it("renders the image with alt text and height when src is set", () => {
    render(<TenantLogo src="data:image/png;base64,AAAA" name="Acme" height={28} />);
    const img = screen.getByAltText("Acme logo");
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(img).toHaveStyle({ height: "28px", maxWidth: "112px" });
  });

  it("falls back to the name when src is null", () => {
    const { container } = render(<TenantLogo src={null} name="Acme" height={28} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText("via AssessIQ")).toBeNull();
  });

  it("appends the via AssessIQ caption when asked", () => {
    render(<TenantLogo src="x.png" name="Acme" height={28} viaAssessIQ />);
    expect(screen.getByText("via AssessIQ")).toBeInTheDocument();
  });
});
