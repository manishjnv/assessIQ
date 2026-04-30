import type { Meta, StoryObj } from "@storybook/react";
import { Chip } from "./Chip";

const meta: Meta<typeof Chip> = {
  title: "primitives/Chip",
  component: Chip,
  argTypes: { variant: { control: "select", options: ["default", "accent", "success"] } },
};
export default meta;
type Story = StoryObj<typeof Chip>;

export const Default: Story = { args: { children: "Workspace" } };
export const Accent: Story = { args: { variant: "accent", children: "AI · matched" } };
export const Success: Story = { args: { variant: "success", children: "Passed" } };
export const WithLeftIcon: Story = { args: { variant: "accent", leftIcon: "sparkle", children: "Auto-saved" } };
export const All: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Chip>Default</Chip>
      <Chip variant="accent">Accent</Chip>
      <Chip variant="success">Success</Chip>
      <Chip variant="accent" leftIcon="clock">30 min</Chip>
    </div>
  ),
};
