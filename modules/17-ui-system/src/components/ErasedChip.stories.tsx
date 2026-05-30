import type { Meta, StoryObj } from "@storybook/react";
import { ErasedChip } from "./ErasedChip";

const meta: Meta<typeof ErasedChip> = {
  title: "primitives/ErasedChip",
  component: ErasedChip,
};
export default meta;
type Story = StoryObj<typeof ErasedChip>;

export const Default: Story = {};

/** Inline next to a candidate name — the typical admin table context. */
export const InlineWithName: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "sans-serif", fontSize: 14 }}>
      <span style={{ color: "#71717a" }}>Erased candidate</span>
      <ErasedChip />
    </div>
  ),
};
