import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Modal } from "./Modal";
import { Button } from "./Button";

const meta: Meta<typeof Modal> = {
  title: "primitives/Modal",
  component: Modal,
  args: { open: true, title: "Rename assessment", onClose: () => {}, children: <p>Modal body content.</p> },
};
export default meta;
type Story = StoryObj<typeof Modal>;

export const Default: Story = {};
export const Wide: Story = { args: { width: 720 } };
function TriggeredDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Rename assessment">
        <p>Press Escape or click the backdrop to close.</p>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </Modal>
    </>
  );
}
export const Triggered: Story = { render: () => <TriggeredDemo /> };
