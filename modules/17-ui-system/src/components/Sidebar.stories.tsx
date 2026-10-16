import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Sidebar, SidebarSection, NavItem } from "./Sidebar";

const meta: Meta<typeof Sidebar> = {
  title: "layout/Sidebar",
  component: Sidebar,
  decorators: [(Story) => <div style={{ height: 420, display: "flex" }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Sidebar>;

const items = (collapsed: boolean) => (
  <>
    <SidebarSection label="Workspace" collapsed={collapsed} />
    <NavItem label="Dashboard" icon="home" active collapsed={collapsed} />
    <NavItem label="Assessments" icon="grid" badge={3} collapsed={collapsed} />
    <NavItem label="Reports" icon="chart" collapsed={collapsed} />
    <NavItem label="Settings" icon="settings" collapsed={collapsed} />
  </>
);

export const Default: Story = { args: { children: items(false), footer: <span>Signed in as admin</span> } };
export const Collapsed: Story = { args: { collapsed: true, children: items(true) } };
function ToggleableDemo() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}>
      {items(collapsed)}
    </Sidebar>
  );
}
export const Toggleable: Story = { render: () => <ToggleableDemo /> };
