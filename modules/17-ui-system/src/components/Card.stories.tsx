import type { Meta, StoryObj } from "@storybook/react";
import { Card } from "./Card";

const meta: Meta<typeof Card> = { title: "layout/Card", component: Card };
export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: {
    padding: "md",
    children: (
      <>
        <h3 className="serif" style={{ margin: 0, marginBottom: 8, fontSize: 22 }}>The library.</h3>
        <p style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>A small body paragraph that demonstrates the card&apos;s resting surface — bordered, rounded, and shadowless.</p>
      </>
    ),
  },
};

export const Interactive: Story = {
  args: { interactive: true, padding: "lg", children: <span>Hover to darken border</span> },
};

export const Floating: Story = {
  args: { floating: true, padding: "lg", children: <span>Floating callout (rare; overlays only)</span> },
};

export const AllPaddings: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12 }}>
      {(["none", "sm", "md", "lg"] as const).map((p) => (
        <Card key={p} padding={p}><span className="mono" style={{ fontSize: 11 }}>padding={p}</span></Card>
      ))}
    </div>
  ),
};
