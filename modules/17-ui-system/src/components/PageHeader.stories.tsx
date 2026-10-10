import type { Meta, StoryObj } from "@storybook/react";
import { PageHeader } from "./PageHeader";
import { Button } from "./Button";

const meta: Meta<typeof PageHeader> = { title: "primitives/PageHeader", component: PageHeader };
export default meta;
type Story = StoryObj<typeof PageHeader>;

export const Default: Story = { args: { title: "Assessments", lede: "Create and manage assessments." } };
export const WithCountAndActions: Story = {
  args: { title: "Assessments", count: 12, lede: "Create and manage assessments.", actions: <Button>New assessment</Button> },
};
