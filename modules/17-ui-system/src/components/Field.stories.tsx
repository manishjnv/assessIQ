import type { Meta, StoryObj } from "@storybook/react";
import { Field } from "./Field";

const meta: Meta<typeof Field> = { title: "primitives/Field", component: Field };
export default meta;
type Story = StoryObj<typeof Field>;

export const Default: Story = { args: { label: "Email", placeholder: "alex@example.com" } };
export const WithHelp: Story = { args: { label: "Email", placeholder: "alex@example.com", help: "We never spam." } };
export const WithError: Story = { args: { label: "Password", type: "password", error: "Required." } };
export const Disabled: Story = { args: { label: "Tenant", disabled: true, defaultValue: "wipro-soc" } };
