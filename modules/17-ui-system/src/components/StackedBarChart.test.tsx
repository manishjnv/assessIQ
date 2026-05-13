import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { StackedBarChart } from "./StackedBarChart";

// Shared fixture: 3 bars, 3 segments each.
const defaultBars = [
  { segments: [10, 20, 30] },
  { segments: [5, 15, 10] },
  { segments: [40, 0, 10] },
];

describe("StackedBarChart", () => {
  it("renders the correct number of bars", () => {
    const { container } = render(<StackedBarChart bars={defaultBars} />);
    const barEls = container.querySelectorAll("[data-bar]");
    expect(barEls).toHaveLength(defaultBars.length);
  });

  it("renders the correct total number of segments across all bars", () => {
    const { container } = render(<StackedBarChart bars={defaultBars} />);
    // Each bar div contains one child div per segment.
    const barEls = container.querySelectorAll("[data-bar]");
    let totalSegments = 0;
    barEls.forEach((bar) => {
      totalSegments += bar.children.length;
    });
    const expectedTotal = defaultBars.reduce((s, b) => s + b.segments.length, 0);
    expect(totalSegments).toBe(expectedTotal);
  });

  it("normalizes mixed-magnitude bars so each fills its proportional chart height", () => {
    // Bar A total = 150; Bar B total = 15. Bar A should be 10× taller.
    const bars = [
      { segments: [100, 50] },
      { segments: [10, 5] },
    ];
    const { container } = render(<StackedBarChart bars={bars} height={200} />);
    const barEls = Array.from(container.querySelectorAll<HTMLElement>("[data-bar]"));
    expect(barEls).toHaveLength(2);

    // Bar A: total 150 / max 150 → 100% of chart height
    expect(barEls[0]!.style.height).toBe("100%");
    // Bar B: total 15 / max 150 → 10% of chart height
    expect(barEls[1]!.style.height).toBe("10%");
  });

  it("honors a custom colors override on segments", () => {
    const bars = [{ segments: [1, 2] }];
    const { container } = render(
      <StackedBarChart bars={bars} colors={["#ff0000", "#00ff00"]} />,
    );
    const barEls = Array.from(container.querySelectorAll("[data-bar]"));
    // First segment (rendered at bottom of flex-col-reverse) has background #ff0000.
    const firstSegment = barEls[0]!.children[0] as HTMLElement;
    expect(firstSegment.style.background).toBe("rgb(255, 0, 0)");
  });

  it("renders yAxisLabels in the DOM when provided", () => {
    const labels = ["28T", "21T", "14T", "7T", "0"];
    const { getByText, queryByText } = render(
      <StackedBarChart bars={defaultBars} yAxisLabels={labels} />,
    );
    expect(getByText("28T")).toBeInTheDocument();
    expect(getByText("0")).toBeInTheDocument();

    // Re-render without labels and confirm they're gone.
    const { container: c2 } = render(<StackedBarChart bars={defaultBars} />);
    // None of the label strings should appear.
    const text = c2.textContent ?? "";
    expect(text).not.toContain("28T");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <StackedBarChart
        bars={defaultBars}
        aria-label="Test stacked bar chart"
        yAxisLabels={["High", "Mid", "Low"]}
        xAxisStartLabel="Jan"
        xAxisEndLabel="Dec"
        seriesLabels={["Series A", "Series B", "Series C"]}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
