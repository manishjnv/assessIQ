import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Table } from "./Table";
import type { ColumnDef, SortDirection } from "./Table";

interface Row {
  id: string;
  name: string;
  status: string;
  score: number;
}

const rows: Row[] = [
  { id: "a1", name: "Ananya Rao", status: "Graded", score: 75 },
  { id: "a2", name: "Rohan Mehta", status: "Graded", score: 50 },
  { id: "a3", name: "Priya Nair", status: "Submitted", score: 0 },
];

const columns: ColumnDef<Row>[] = [
  { key: "name", label: "Candidate", sortable: true },
  { key: "status", label: "Status" },
  { key: "score", label: "Score", sortable: true, width: 100 },
];

const meta: Meta<typeof Table<Row>> = {
  title: "primitives/Table",
  component: Table<Row>,
  args: { data: rows, columns, rowKey: (r) => r.id },
};
export default meta;
type Story = StoryObj<typeof Table<Row>>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { data: [], emptyMessage: "No attempts yet." } };
function SortableDemo() {
  const [dir, setDir] = useState<SortDirection>("asc");
  const sorted = [...rows].sort((a, b) => (dir === "asc" ? a.score - b.score : b.score - a.score));
  return <Table data={sorted} columns={columns} rowKey={(r) => r.id} sortBy="score" sortDir={dir} onSort={(_k, d) => setDir(d)} />;
}
export const Sortable: Story = { render: () => <SortableDemo /> };
export const Expanded: Story = {
  args: { expandedId: "a1", renderExpanded: (r) => <div>Details for {r.name}</div> },
};
