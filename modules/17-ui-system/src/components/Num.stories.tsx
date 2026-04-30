import type { Meta, StoryObj } from "@storybook/react";
import { Num } from "./Num";

const meta: Meta<typeof Num> = { title: "primitives/Num", component: Num };
export default meta;
type Story = StoryObj<typeof Num>;

export const Static: Story = { args: { value: 132, style: { fontSize: 64 } } };
export const Animated: Story = { args: { value: 132, animate: true, style: { fontSize: 64 } } };
export const Percent: Story = { args: { value: 97, animate: true, format: (n: number) => `${n}%`, style: { fontSize: 48 } } };
export const Comparative: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 32 }}>
      <div>
        <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-secondary)" }}>Score</div>
        <Num value={132} animate style={{ fontSize: 64 }} />
      </div>
      <div>
        <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-secondary)" }}>Percentile</div>
        <Num value={97} animate format={(n: number) => `${n}th`} style={{ fontSize: 64 }} />
      </div>
    </div>
  ),
};
