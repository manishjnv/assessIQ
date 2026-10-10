import type { Meta, StoryObj } from "@storybook/react";
import { StatusPill } from "./StatusPill";

const meta: Meta<typeof StatusPill> = { title: "primitives/StatusPill", component: StatusPill };
export default meta;
type Story = StoryObj<typeof StatusPill>;

export const Default: Story = { args: { status: "draft" } };
export const Mapped: Story = { args: { status: "in_progress", labels: { in_progress: "In progress" }, tone: "accent" } };
