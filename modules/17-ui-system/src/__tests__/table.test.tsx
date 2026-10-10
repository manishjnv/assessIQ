import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { axe } from "vitest-axe";
import React, { useState } from "react";
afterEach(() => cleanup());

import { Table } from "../index.js";
import type { ColumnDef } from "../index.js";

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

function Harness({ loading = false }: { loading?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const columns: ColumnDef<Row>[] = [
    { key: "name", label: "Name", sortable: true },
    {
      key: "action",
      label: "",
      render: (r) => (
        <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
          Details {r.name}
        </button>
      ),
    },
  ];
  return (
    <Table<Row>
      data={rows}
      columns={columns}
      rowKey={(r) => r.id}
      expandedId={open}
      renderExpanded={(r) => <p>Detail for {r.name}</p>}
      loading={loading}
      sortBy="name"
      sortDir="asc"
      onSort={() => {}}
    />
  );
}

describe("Table", () => {
  it("has table semantics and is axe-clean with an expanded row", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText("Details Alpha"));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    expect((await axe(container)).violations).toEqual([]);
  });

  it("toggles the full-width detail row", () => {
    render(<Harness />);
    expect(screen.queryByText("Detail for Alpha")).toBeNull();
    fireEvent.click(screen.getByText("Details Alpha"));
    const detail = screen.getByText("Detail for Alpha");
    expect(detail.closest('[role="cell"]')).toHaveAttribute("aria-colspan", "2");
    expect(screen.getByText("Details Alpha")).toHaveAttribute("aria-expanded", "true");
    // detail row sits directly after its trigger row, inside the same table
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows[1]).toContainElement(detail);
    fireEvent.click(screen.getByText("Details Alpha"));
    expect(screen.queryByText("Detail for Alpha")).toBeNull();
  });

  it("renders loading as a status row inside the table", async () => {
    const { container } = render(<Harness loading />);
    const status = screen.getByRole("status");
    expect(status.closest('[role="row"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("renders the empty message as a row", async () => {
    const { container } = render(<Table<Row> data={[]} columns={[{ key: "name", label: "Name" }]} emptyMessage="Nothing." />);
    expect(screen.getByText("Nothing.").closest('[role="row"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });
});
