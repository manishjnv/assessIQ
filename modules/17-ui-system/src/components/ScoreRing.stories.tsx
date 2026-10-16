import type { Meta, StoryObj } from "@storybook/react";
import { ScoreRing } from "./ScoreRing";

const meta: Meta<typeof ScoreRing> = {
  title: "charts/ScoreRing",
  component: ScoreRing,
  argTypes: {
    size: { control: "select", options: ["sm", "md", "lg"] },
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
};
export default meta;
type Story = StoryObj<typeof ScoreRing>;

export const Default: Story = { args: { value: 75 } };
export const WithLabel: Story = { args: { value: 50, label: "band 2", size: "lg" } };
export const Zero: Story = { args: { value: 0, size: "sm" } };
export const All: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <ScoreRing value={25} size="sm" />
      <ScoreRing value={75} size="md" />
      <ScoreRing value={100} size="lg" label="band 4" />
    </div>
  ),
};
