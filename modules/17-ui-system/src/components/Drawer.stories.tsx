import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Drawer } from "./Drawer";
import { Button } from "./Button";

const meta: Meta<typeof Drawer> = {
  title: "primitives/Drawer",
  component: Drawer,
  args: { open: true, title: "Attempt details", onClose: () => {}, children: <p>Drawer body content.</p> },
};
export default meta;
type Story = StoryObj<typeof Drawer>;

export const Default: Story = {};
export const Narrow: Story = { args: { width: 360 } };
function TriggeredDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open drawer</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Attempt details">
        <p>Press Escape or click the backdrop to close.</p>
      </Drawer>
    </>
  );
}
export const Triggered: Story = { render: () => <TriggeredDemo /> };
