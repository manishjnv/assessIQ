import type { Meta, StoryObj } from "@storybook/react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

const meta: Meta<typeof Icon> = { title: "primitives/Icon", component: Icon };
export default meta;
type Story = StoryObj<typeof Icon>;

const ALL_NAMES: IconName[] = [
  "search",
  "arrow",
  "arrowLeft",
  "check",
  "clock",
  "home",
  "grid",
  "chart",
  "user",
  "settings",
  "plus",
  "close",
  "play",
  "pause",
  "flag",
  "book",
  "code",
  "drag",
  "bell",
  "eye",
  "sparkle",
  "google",
];

export const Default: Story = { args: { name: "search" } };

export const All: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
        gap: 12,
      }}
    >
      {ALL_NAMES.map((n) => (
        <div
          key={n}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: 12,
            border: "1px solid var(--aiq-color-border)",
            borderRadius: 12,
          }}
        >
          <Icon name={n} size={20} aria-label={n} />
          <span
            className="mono"
            style={{ fontSize: 10, color: "var(--aiq-color-fg-muted)" }}
          >
            {n}
          </span>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {[12, 16, 20, 24, 32].map((s) => (
        <Icon key={s} name="sparkle" size={s} aria-hidden />
      ))}
    </div>
  ),
};

export const Accent: Story = {
  render: () => (
    <span style={{ color: "var(--aiq-color-accent)" }}>
      <Icon name="sparkle" size={24} aria-hidden />
    </span>
  ),
};
