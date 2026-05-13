import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { ProgressBar } from "./ProgressBar";

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ width: 320 }}>{children}</div>
);

const meta: Meta<typeof ProgressBar> = {
  title: "primitives/ProgressBar",
  component: ProgressBar,
  decorators: [(Story) => <Wrapper><Story /></Wrapper>],
  argTypes: {
    variant: { control: "select", options: ["accent", "success", "fg"] },
    height: { control: "select", options: [2, 4, 6] },
    value: { control: { type: "range", min: 0, max: 100 } },
  },
};
export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = { args: { value: 60, label: "Progress" } };

export const Success: Story = {
  args: { variant: "success", value: 100, label: "Complete" },
};

export const Foreground: Story = {
  args: { variant: "fg", value: 33, label: "Loading" },
};

export const Heights: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ProgressBar value={60} height={2} label="Height 2" />
      <ProgressBar value={60} height={4} label="Height 4" />
      <ProgressBar value={60} height={6} label="Height 6" />
    </div>
  ),
};
