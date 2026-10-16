import type { Meta, StoryObj } from "@storybook/react";
import { StatCard } from "./StatCard";

const meta: Meta<typeof StatCard> = {
  title: "primitives/StatCard",
  component: StatCard,
  args: { label: "Attempts graded", value: 128 },
};
export default meta;
type Story = StoryObj<typeof StatCard>;

export const Default: Story = {};
export const WithSparkline: Story = {
  args: { sparkline: [4, 6, 5, 9, 8, 12, 11, 15, 14, 18], delta: 3 },
};
export const NegativeDelta: Story = {
  args: { label: "Pass rate", value: 72, unit: "%", sparkline: [20, 18, 19, 15, 14, 12, 13], delta: -4 },
};
export const WithBreakdown: Story = {
  args: {
    breakdown: [
      { label: "Band 4", value: 61, pct: 0.48 },
      { label: "Band 3", value: 38, pct: 0.3 },
      { label: "Band 2", value: 20, pct: 0.16 },
      { label: "Band 1", value: 9, pct: 0.06 },
    ],
  },
};
