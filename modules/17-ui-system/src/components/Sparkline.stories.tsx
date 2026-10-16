import type { Meta, StoryObj } from "@storybook/react";
import { Sparkline } from "./Sparkline";

const meta: Meta<typeof Sparkline> = {
  title: "charts/Sparkline",
  component: Sparkline,
  args: { data: [4, 6, 5, 9, 8, 12, 11, 15, 14, 18] },
};
export default meta;
type Story = StoryObj<typeof Sparkline>;

export const Default: Story = {};
export const NoFill: Story = { args: { fill: false } };
export const Large: Story = { args: { width: 320, height: 96, strokeWidth: 2 } };
export const Falling: Story = { args: { data: [18, 16, 17, 12, 11, 8, 9, 5, 4, 2], color: "var(--aiq-color-danger)" } };
