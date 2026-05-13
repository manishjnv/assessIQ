import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { axe } from "vitest-axe";
import { LeaderboardList } from "./LeaderboardList";
import type { LeaderboardListItem } from "./LeaderboardList";

const ITEMS: LeaderboardListItem[] = [
  { name: "Logical Reasoning III", subline: "by AccessIQ Cognitive", metric: "4.2k takers", delta: { value: "+12%", up: true } },
  { name: "Frontend Engineering",  subline: "by AccessIQ Technical", metric: "3.8k takers", delta: { value: "+8%",  up: true } },
  { name: "Big Five Profile",       subline: "by AccessIQ Personality", metric: "3.4k takers", delta: { value: "-4%",  up: false } },
  { name: "SQL & Data Modeling",    subline: "by AccessIQ Technical", metric: "2.9k takers", delta: { value: "-3%",  up: false } },
];

describe("LeaderboardList", () => {
  it("renders all items as list elements", () => {
    const { container } = render(<LeaderboardList items={ITEMS} />);
    expect(container.querySelectorAll("li").length).toBe(ITEMS.length);
  });

  it("renders 1-indexed rank numbers in order", () => {
    const { getByText } = render(<LeaderboardList items={ITEMS} />);
    expect(getByText("1.")).toBeInTheDocument();
    expect(getByText("2.")).toBeInTheDocument();
    expect(getByText("3.")).toBeInTheDocument();
    expect(getByText("4.")).toBeInTheDocument();
  });

  it("renders delta with correct arrow icon and success/danger color", () => {
    const { container } = render(<LeaderboardList items={ITEMS} />);
    const deltaEls = container.querySelectorAll("li > div:last-child > div:last-child");

    // First item: up=true → ↑, success color
    const upDelta = deltaEls[0] as HTMLElement;
    expect(upDelta.textContent).toContain("↑");
    expect(upDelta.style.color).toBe("var(--aiq-color-success)");

    // Third item: up=false → ↓, danger color
    const downDelta = deltaEls[2] as HTMLElement;
    expect(downDelta.textContent).toContain("↓");
    expect(downDelta.style.color).toBe("var(--aiq-color-danger)");
  });

  it("strips leading + and - from delta value strings", () => {
    const items: LeaderboardListItem[] = [
      { name: "Test A", metric: "100", delta: { value: "+12%", up: true } },
      { name: "Test B", metric: "200", delta: { value: "-5%",  up: false } },
    ];
    const { getByText, queryByText } = render(<LeaderboardList items={items} />);

    // Stripped values should appear
    expect(getByText(/12%/)).toBeInTheDocument();
    expect(getByText(/5%/)).toBeInTheDocument();

    // Leading +/- must not appear in the delta text nodes
    expect(queryByText(/\+12%/)).toBeNull();
    expect(queryByText(/-5%/)).toBeNull();
  });

  it("renders Show More button only when onShowMore is provided and calls it on click", () => {
    const { queryByRole, rerender, getByRole } = render(
      <LeaderboardList items={ITEMS} />,
    );

    // No button without prop
    expect(queryByRole("button", { name: /show more/i })).toBeNull();

    const handler = vi.fn();
    rerender(<LeaderboardList items={ITEMS} onShowMore={handler} />);

    const btn = getByRole("button", { name: /show more/i });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    const { container } = render(<LeaderboardList items={ITEMS} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
