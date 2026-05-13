import type { Meta, StoryObj } from "@storybook/react";
import { Placeholder } from "./Placeholder";

const meta: Meta<typeof Placeholder> = {
  title: "primitives/Placeholder",
  component: Placeholder,
};
export default meta;
type Story = StoryObj<typeof Placeholder>;

export const Default: Story = { args: { width: 320, height: 200 } };
export const WithCaption: Story = { args: { caption: "diagram pending" } };
export const Tall: Story = { args: { width: 240, height: 360 } };
export const Gallery: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16 }}>
      <Placeholder width={240} height={160} />
      <Placeholder width={240} height={160} caption="screenshot" />
      <Placeholder width={240} height={160} caption="chart" />
    </div>
  ),
};
