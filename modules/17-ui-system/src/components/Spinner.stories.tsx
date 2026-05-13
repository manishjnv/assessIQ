import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "./Spinner";

const meta: Meta<typeof Spinner> = {
  title: "primitives/Spinner",
  component: Spinner,
  argTypes: { size: { control: "select", options: ["sm", "md", "lg"] } },
};
export default meta;
type Story = StoryObj<typeof Spinner>;

export const Default: Story = { args: { size: "md" } };
export const Small: Story = { args: { size: "sm" } };
export const Large: Story = { args: { size: "lg" } };
export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  ),
};
