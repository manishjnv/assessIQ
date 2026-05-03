// AssessIQ — Table component.
//
// Server-paginated, filterable, sortable data table.
// Pagination via opaque cursors (not page numbers).
// Pure CSS grid layout — no virtualization (Phase 2 scale).
//
// INVARIANTS (branding-guideline.md):
//  - No box-shadow at rest.
//  - Mono for IDs and timestamps; serif for numbers.

import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

export interface ColumnDef<T> {
  /** Column key (must be unique). */
  key: string;
  /** Column header label. */
  label: string;
  /** Whether this column is sortable. */
  sortable?: boolean;
  /** Custom render function. If omitted, `String(row[key])` is used. */
  render?: (row: T) => React.ReactNode;
  /** Pixel width hint. */
  width?: number | string;
}

export interface TableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  /** Opaque cursor for the next page. Null or undefined = no next page. */
  cursor?: string | null;
  /** Called when the user requests the next page. */
  onLoadMore?: (cursor: string) => void;
  /** True while a page fetch is in flight. */
  loading?: boolean;
  /** Currently sorted column key. */
  sortBy?: string;
  /** Current sort direction. */
  sortDir?: SortDirection;
  /** Called when a sortable column header is clicked. */
  onSort?: (key: string, dir: SortDirection) => void;
  /** Empty state message. */
  emptyMessage?: string;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Table<T extends Record<string, unknown>>({
  data,
  columns,
  cursor,
  onLoadMore,
  loading = false,
  sortBy,
  sortDir,
  onSort,
  emptyMessage = "No data.",
  "data-test-id": testId,
}: TableProps<T>): React.ReactElement {
  const gridTemplateColumns = columns
    .map((c) => (c.width ? String(c.width) : "1fr"))
    .join(" ");

  function handleSortClick(col: ColumnDef<T>) {
    if (!col.sortable || !onSort) return;
    const nextDir: SortDirection =
      sortBy === col.key && sortDir === "asc" ? "desc" : "asc";
    onSort(col.key, nextDir);
  }

  return (
    <div data-test-id={testId} style={{ width: "100%" }}>
      {/* Header row */}
      <div
        role="rowgroup"
        style={{
          display: "grid",
          gridTemplateColumns,
          borderBottom: "1px solid var(--aiq-color-border-strong)",
          padding: "0 var(--aiq-space-md)",
        }}
      >
        {columns.map((col) => (
          <div
            key={col.key}
            role="columnheader"
            aria-sort={
              sortBy === col.key
                ? sortDir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined
            }
            onClick={() => handleSortClick(col)}
            style={{
              padding: "var(--aiq-space-sm) var(--aiq-space-xs)",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--aiq-color-fg-muted)",
              cursor: col.sortable ? "pointer" : "default",
              userSelect: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {col.label}
            {col.sortable && sortBy === col.key && (
              <span style={{ fontSize: 9 }}>{sortDir === "asc" ? "▲" : "▼"}</span>
            )}
          </div>
        ))}
      </div>

      {/* Body rows */}
      <div role="rowgroup">
        {data.length === 0 && !loading && (
          <div
            style={{
              padding: "var(--aiq-space-3xl)",
              textAlign: "center",
              color: "var(--aiq-color-fg-muted)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-md)",
            }}
          >
            {emptyMessage}
          </div>
        )}
        {data.map((row, idx) => (
          <div
            key={idx}
            role="row"
            style={{
              display: "grid",
              gridTemplateColumns,
              padding: "0 var(--aiq-space-md)",
              borderBottom: "1px solid var(--aiq-color-border)",
              transition: "background var(--aiq-motion-duration-fast)",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.background =
                "var(--aiq-color-bg-sunken)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.background = "")
            }
          >
            {columns.map((col) => (
              <div
                key={col.key}
                role="cell"
                style={{
                  padding: "var(--aiq-space-sm) var(--aiq-space-xs)",
                  fontSize: "var(--aiq-text-md)",
                  color: "var(--aiq-color-fg-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {col.render ? col.render(row) : String(row[col.key] ?? "")}
              </div>
            ))}
          </div>
        ))}
        {loading && (
          <div
            style={{
              padding: "var(--aiq-space-lg)",
              textAlign: "center",
              color: "var(--aiq-color-fg-muted)",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
            }}
          >
            Loading…
          </div>
        )}
      </div>

      {/* Load more */}
      {cursor && onLoadMore && !loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "var(--aiq-space-md)" }}>
          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            onClick={() => onLoadMore(cursor)}
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

Table.displayName = "Table";
