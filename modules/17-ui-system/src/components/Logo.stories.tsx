import type { Meta, StoryObj } from "@storybook/react";
import { Logo } from "./Logo";

const meta: Meta<typeof Logo> = { title: "primitives/Logo", component: Logo };
export default meta;
type Story = StoryObj<typeof Logo>;

export const Default: Story = { args: {} };
export const MarkOnly: Story = { args: { showWordmark: false } };
export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
      {[16, 18, 24, 32, 48].map((s) => <Logo key={s} size={s} />)}
    </div>
  ),
};
