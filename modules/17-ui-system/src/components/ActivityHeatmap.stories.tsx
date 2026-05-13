import type { Meta, StoryObj } from "@storybook/react";
import { ActivityHeatmap } from "./ActivityHeatmap";

const meta: Meta<typeof ActivityHeatmap> = {
  title: "primitives/ActivityHeatmap",
  component: ActivityHeatmap,
  argTypes: {
    weeks: { control: { type: "number", min: 1, max: 52 } },
    streakSummary: { control: "text" },
    legendLessLabel: { control: "text" },
    legendMoreLabel: { control: "text" },
  },
};
export default meta;
type Story = StoryObj<typeof ActivityHeatmap>;

const MONTH_LABELS = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"];

/** Climbing pattern: cycles 0→4 across all 364 cells. */
export const Default: Story = {
  args: {
    data: Array.from({ length: 364 }, (_, i) => i % 5),
    "aria-label": "Activity heatmap — default",
  },
};

/** Full heatmap with streak summary and month labels. */
export const WithStreak: Story = {
  args: {
    data: Array.from({ length: 364 }, (_, i) => i % 5),
    streakSummary: "42-day streak · longest 71 days",
    monthLabels: MONTH_LABELS,
    "aria-label": "Activity heatmap — with streak",
  },
};

/** All-zero data — user has no recorded activity. */
export const Empty: Story = {
  args: {
    data: Array(364).fill(0),
    streakSummary: "No activity yet",
    monthLabels: MONTH_LABELS,
    "aria-label": "Activity heatmap — empty",
  },
};

/** Multiple heatmaps stacked vertically to show layout in context. */
export const Showcase: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <ActivityHeatmap
        data={Array.from({ length: 364 }, (_, i) => i % 5)}
        aria-label="Climbing pattern heatmap"
      />
      <ActivityHeatmap
        data={Array.from({ length: 364 }, (_, i) => i % 5)}
        streakSummary="42-day streak · longest 71 days"
        monthLabels={MONTH_LABELS}
        aria-label="Heatmap with streak and months"
      />
      <ActivityHeatmap
        data={Array(364).fill(0)}
        streakSummary="No activity yet"
        monthLabels={MONTH_LABELS}
        legendLessLabel="Quiet"
        legendMoreLabel="Busy"
        aria-label="Empty heatmap with custom labels"
      />
    </div>
  ),
};
