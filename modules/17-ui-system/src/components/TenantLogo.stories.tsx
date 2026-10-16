import type { Meta, StoryObj } from "@storybook/react";
import { TenantLogo } from "./TenantLogo";

const PIXEL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="28"><rect width="96" height="28" rx="4" fill="#5b7bd5"/></svg>',
  );

const meta: Meta<typeof TenantLogo> = { title: "primitives/TenantLogo", component: TenantLogo };
export default meta;
type Story = StoryObj<typeof TenantLogo>;

export const WithLogo: Story = { args: { src: PIXEL, name: "Acme College", height: 28 } };
export const NameOnly: Story = { args: { src: null, name: "Acme College", height: 28 } };
export const CoBranded: Story = { args: { src: PIXEL, name: "Acme College", height: 28, viaAssessIQ: true } };
