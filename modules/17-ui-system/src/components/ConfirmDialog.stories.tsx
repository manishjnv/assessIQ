import type { Meta, StoryObj } from "@storybook/react";
import { ConfirmDialog } from "./ConfirmDialog";

const meta: Meta<typeof ConfirmDialog> = {
  title: "primitives/ConfirmDialog",
  component: ConfirmDialog,
  args: { open: true, title: "Delete question set?", body: "This cannot be undone.", confirmLabel: "Delete", onConfirm: () => {}, onCancel: () => {} },
};
export default meta;
type Story = StoryObj<typeof ConfirmDialog>;

export const Default: Story = {};
export const Danger: Story = { args: { danger: true } };
export const Busy: Story = { args: { danger: true, busy: true } };
