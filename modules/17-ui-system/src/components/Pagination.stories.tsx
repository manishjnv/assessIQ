import type { Meta, StoryObj } from "@storybook/react";
import { Pagination } from "./Pagination";

const meta: Meta<typeof Pagination> = { title: "primitives/Pagination", component: Pagination, args: { onPageChange: () => {} } };
export default meta;
type Story = StoryObj<typeof Pagination>;

export const Middle: Story = { args: { page: 2, pageSize: 25, total: 100 } };
export const FirstPage: Story = { args: { page: 1, pageSize: 25, total: 100 } };
export const Empty: Story = { args: { page: 1, pageSize: 25, total: 0 } };
