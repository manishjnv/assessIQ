import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "./ThemeProvider";
import { TENANT_FIXTURES } from "../fixtures/tenants";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Num } from "../components/Num";

const meta: Meta<typeof ThemeProvider> = {
  title: "theme/ThemeProvider",
  component: ThemeProvider,
};
export default meta;
type Story = StoryObj<typeof ThemeProvider>;

const Demo = () => (
  <Card padding="lg">
    <Chip variant="accent">AI · matched</Chip>
    <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "baseline" }}>
      <Num value={132} animate style={{ fontSize: 56 }} />
      <Button>Continue</Button>
    </div>
  </Card>
);

export const WiproSoc: Story = {
  args: { branding: TENANT_FIXTURES["wipro-soc"]!.branding, children: <Demo /> },
};

export const DemoBlue: Story = {
  args: { branding: TENANT_FIXTURES["demo-blue"]!.branding, children: <Demo /> },
};

export const DemoTeal: Story = {
  args: { branding: TENANT_FIXTURES["demo-teal"]!.branding, children: <Demo /> },
};

export const Compact: Story = {
  args: {
    branding: TENANT_FIXTURES["wipro-soc"]!.branding,
    density: "compact",
    children: <Demo />,
  },
};

export const ForcedDark: Story = {
  args: {
    branding: TENANT_FIXTURES["demo-blue"]!.branding,
    theme: "dark",
    children: <Demo />,
  },
};
