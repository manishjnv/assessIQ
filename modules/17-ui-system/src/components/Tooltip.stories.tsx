import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";
import { Tooltip } from "./Tooltip";

const meta: Meta<typeof Tooltip> = {
  title: "primitives/Tooltip",
  component: Tooltip,
  argTypes: {
    placement: {
      control: "select",
      options: ["top", "bottom", "left", "right"],
    },
  },
  parameters: {
    layout: "centered",
  },
};
export default meta;
type Story = StoryObj<typeof Tooltip>;

export const Default: Story = {
  render: () => (
    <Tooltip content="A short tip">
      <Button>Hover me</Button>
    </Tooltip>
  ),
};

export const Placements: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 48,
        alignItems: "center",
        justifyItems: "center",
        padding: 64,
      }}
    >
      <Tooltip content="Tip above" placement="top">
        <Button variant="outline">Top</Button>
      </Tooltip>
      <Tooltip content="Tip below" placement="bottom">
        <Button variant="outline">Bottom</Button>
      </Tooltip>
      <Tooltip content="Tip to the left" placement="left">
        <Button variant="outline">Left</Button>
      </Tooltip>
      <Tooltip content="Tip to the right" placement="right">
        <Button variant="outline">Right</Button>
      </Tooltip>
    </div>
  ),
};

export const LongContent: Story = {
  render: () => (
    <div style={{ padding: 80, display: "flex", justifyContent: "center" }}>
      <Tooltip
        content="This tooltip contains a longer description that demonstrates how the popover handles text wrapping. The max-width is 280 px. If the trigger is near a viewport edge, the popover may overflow — choose a different placement in that case."
        placement="top"
      >
        <Button variant="outline">Long content — hover me</Button>
      </Tooltip>
    </div>
  ),
};
