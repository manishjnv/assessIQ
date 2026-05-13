import type { Meta, StoryObj } from "@storybook/react";
import { LeaderboardList } from "./LeaderboardList.js";

const meta: Meta<typeof LeaderboardList> = {
  title: "primitives/LeaderboardList",
  component: LeaderboardList,
  argTypes: {
    columns: { control: "select", options: [1, 2] },
  },
};
export default meta;
type Story = StoryObj<typeof LeaderboardList>;

/** Kit data from activity.jsx:147-156 */
const KIT_ITEMS = [
  { name: "Logical Reasoning III", subline: "by AccessIQ Cognitive", metric: "4.2k takers", delta: { value: "+12%", up: true } },
  { name: "Frontend Engineering",  subline: "by AccessIQ Technical", metric: "3.8k takers", delta: { value: "+8%",  up: true } },
  { name: "Big Five Profile",       subline: "by AccessIQ Personality", metric: "3.4k takers", delta: { value: "+4%",  up: true } },
  { name: "SQL & Data Modeling",    subline: "by AccessIQ Technical", metric: "2.9k takers", delta: { value: "-3%",  up: false } },
  { name: "Numerical Reasoning",    subline: "by AccessIQ Cognitive", metric: "2.7k takers", delta: { value: "+18%", up: true } },
  { name: "Business English C1",    subline: "by AccessIQ Language",  metric: "2.1k takers", delta: { value: "+6%",  up: true } },
  { name: "Spatial Reasoning II",   subline: "by AccessIQ Cognitive", metric: "1.8k takers", delta: { value: "-1%",  up: false } },
  { name: "Customer Support Sim",   subline: "by AccessIQ Custom",    metric: "1.4k takers", delta: { value: "+22%", up: true } },
];

export const Default: Story = {
  args: {
    items: KIT_ITEMS,
    columns: 2,
  },
};

export const OneColumn: Story = {
  args: {
    items: KIT_ITEMS,
    columns: 1,
  },
};

export const WithShowMore: Story = {
  args: {
    items: KIT_ITEMS,
    columns: 2,
    onShowMore: () => alert("clicked"),
    showMoreLabel: "Show more",
  },
};

export const Showcase: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 48 }}>
      <div>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--aiq-color-fg-muted)" }}>
          Default (2-column)
        </p>
        <LeaderboardList items={KIT_ITEMS} columns={2} />
      </div>
      <div>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--aiq-color-fg-muted)" }}>
          With Show More button
        </p>
        <LeaderboardList
          items={KIT_ITEMS}
          columns={2}
          onShowMore={() => alert("clicked")}
        />
      </div>
    </div>
  ),
};
