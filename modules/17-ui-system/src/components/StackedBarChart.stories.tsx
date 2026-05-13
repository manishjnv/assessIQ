import type { Meta, StoryObj } from "@storybook/react";
import { StackedBarChart } from "./StackedBarChart";
import type { StackedBarChartBar } from "./StackedBarChart";

// ---------------------------------------------------------------------------
// Shared fixture — mirrors the kit's activity.jsx:109-117 data generation.
// 36 bars, 7 segments per bar, using the production distribution.
// ---------------------------------------------------------------------------

const SEGMENTS_DIST = [0.46, 0.18, 0.14, 0.10, 0.06, 0.04, 0.02];

function makeClimbingBars(count: number): StackedBarChartBar[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / count;
    const base = 12 + t * 70;
    const noise = (((i * 9301) % 47) / 47) * 18 - 9;
    const height = Math.max(8, base + noise);
    return {
      segments: SEGMENTS_DIST.map((share) => share * height),
      label: `Bar ${i + 1}`,
    };
  });
}

const defaultBars = makeClimbingBars(36);

const SERIES_LABELS = [
  "Logical",
  "Verbal",
  "Numerical",
  "Spatial",
  "Memory",
  "Attention",
  "Speed",
];

const Y_AXIS_LABELS = ["28T", "21T", "14T", "7T", "0"];

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta<typeof StackedBarChart> = {
  title: "charts/StackedBarChart",
  component: StackedBarChart,
  argTypes: {
    height: { control: { type: "range", min: 80, max: 400, step: 8 } },
    gap: { control: { type: "range", min: 0, max: 16, step: 1 } },
  },
};
export default meta;
type Story = StoryObj<typeof StackedBarChart>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Default: Story = {
  args: {
    bars: defaultBars,
    seriesLabels: SERIES_LABELS,
    xAxisStartLabel: "May 2025",
    xAxisEndLabel: "May 2026",
    "aria-label": "Assessment activity over the past year",
  },
};

export const WithYAxis: Story = {
  args: {
    ...Default.args,
    yAxisLabels: Y_AXIS_LABELS,
  },
};

export const ShortRange: Story = {
  args: {
    bars: makeClimbingBars(12),
    xAxisStartLabel: "Jan 2026",
    xAxisEndLabel: "Dec 2026",
    "aria-label": "Assessment activity — last 12 periods",
  },
};

export const Showcase: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 40, padding: 24 }}>
      <div>
        <p
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: 11,
            color: "var(--aiq-color-fg-secondary)",
            marginBottom: 8,
          }}
        >
          Default (no y-axis)
        </p>
        <StackedBarChart
          bars={defaultBars}
          seriesLabels={SERIES_LABELS}
          xAxisStartLabel="May 2025"
          xAxisEndLabel="May 2026"
          aria-label="Assessment activity over the past year — no y-axis"
        />
      </div>
      <div>
        <p
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: 11,
            color: "var(--aiq-color-fg-secondary)",
            marginBottom: 8,
          }}
        >
          With y-axis labels
        </p>
        <StackedBarChart
          bars={defaultBars}
          seriesLabels={SERIES_LABELS}
          yAxisLabels={Y_AXIS_LABELS}
          xAxisStartLabel="May 2025"
          xAxisEndLabel="May 2026"
          aria-label="Assessment activity over the past year — with y-axis"
        />
      </div>
    </div>
  ),
};
