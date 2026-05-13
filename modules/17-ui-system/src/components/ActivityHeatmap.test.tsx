import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { ActivityHeatmap } from "./ActivityHeatmap";

const defaultData = Array.from({ length: 364 }, (_, i) => i % 5);

describe("ActivityHeatmap", () => {
  it("renders 364 cells by default (52 weeks × 7 days)", () => {
    const { container } = render(<ActivityHeatmap data={defaultData} />);
    const cells = container.querySelectorAll("[data-cell]");
    expect(cells.length).toBe(364);
  });

  it("clamps out-of-range values: negative → heatmap-0, >4 → heatmap-4", () => {
    const { container } = render(
      <ActivityHeatmap data={[-1, 5, 99]} weeks={1} />,
    );
    const cells = Array.from(container.querySelectorAll<HTMLElement>("[data-cell]"));
    // 1 week × 7 days = 7 cells; first three have the provided values, rest padded with 0
    expect(cells[0]!.style.background).toBe("var(--aiq-color-heatmap-0)");
    expect(cells[1]!.style.background).toBe("var(--aiq-color-heatmap-4)");
    expect(cells[2]!.style.background).toBe("var(--aiq-color-heatmap-4)");
  });

  it("renders streakSummary when provided and omits it when absent", () => {
    const { queryByText, unmount } = render(
      <ActivityHeatmap
        data={defaultData}
        streakSummary="42-day streak · longest 71 days"
      />,
    );
    expect(queryByText("42-day streak · longest 71 days")).toBeInTheDocument();
    unmount();

    const { queryByText: queryByText2 } = render(
      <ActivityHeatmap data={defaultData} />,
    );
    expect(queryByText2("42-day streak · longest 71 days")).toBeNull();
  });

  it("renders correct cell count for custom weeks prop", () => {
    const { container } = render(
      <ActivityHeatmap data={Array(140).fill(1)} weeks={20} />,
    );
    const cells = container.querySelectorAll("[data-cell]");
    expect(cells.length).toBe(140);
  });

  it("respects custom aria-label on the grid region", () => {
    const { container } = render(
      <ActivityHeatmap data={defaultData} aria-label="My custom heatmap" />,
    );
    const grid = container.querySelector('[role="img"]');
    expect(grid).toHaveAttribute("aria-label", "My custom heatmap");
  });

  it("defaults aria-label to 'Activity over N weeks' when not provided", () => {
    const { container } = render(<ActivityHeatmap data={defaultData} weeks={26} />);
    const grid = container.querySelector('[role="img"]');
    expect(grid).toHaveAttribute("aria-label", "Activity over 26 weeks");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ActivityHeatmap
        data={defaultData}
        streakSummary="42-day streak · longest 71 days"
        monthLabels={["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"]}
        aria-label="Activity heatmap"
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
