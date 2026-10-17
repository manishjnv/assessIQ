import type { Meta, StoryObj } from "@storybook/react";
import { MyAccountCard } from "./MyAccountCard";

const meta: Meta<typeof MyAccountCard> = {
  title: "admin/MyAccountCard",
  component: MyAccountCard,
  args: { initial: "A", name: "asha.rao", roleLabel: "Admin", enrolled: true, onRegenerate: () => {}, onEnrol: () => {}, onSignOut: () => {} },
  decorators: [(Story) => <div style={{ width: 240, padding: 16 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof MyAccountCard>;

export const TwoFactorOn: Story = {};
export const TwoFactorOff: Story = { args: { enrolled: false } };
