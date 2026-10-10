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
import { Spinner } from "./Spinner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

export interface ColumnDef<T = unknown> {
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
  /** Stable row key. Required for `expandedId` to match a row. Defaults to the row index. */
  rowKey?: (row: T) => string;
  /** Key of the row whose detail row is open. The caller owns the toggle. */
  expandedId?: string | null;
  /** Content of the full-width detail row rendered under the expanded row. */
  renderExpanded?: (row: T) => React.ReactNode;
  /** Extra per-row style (e.g. a sunken background for child rows). */
  rowStyle?: (row: T) => React.CSSProperties;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Table<T>({
  data,
  columns,
  cursor,
  onLoadMore,
  loading = false,
  sortBy,
  sortDir,
  onSort,
  emptyMessage = "No data.",
  rowKey,
  expandedId,
  renderExpanded,
  rowStyle,
  "data-test-id": testId,
}: TableProps<T>): React.ReactElement {
  // Width: a bare number is a pixel length. A string is passed through as-is
  // (so callers can pass "1fr", "minmax(120px, 1fr)", "auto", etc.). Without
  // the `px` suffix, a numeric width like `80` produced "80" — an invalid
  // CSS grid track length that silently invalidated the whole
  // grid-template-columns declaration and collapsed the table into a single
  // implicit column.
  const gridTemplateColumns = columns
    .map((c) =>
      typeof c.width === "number"
        ? `${c.width}px`
        : c.width != null && c.width !== ""
          ? c.width
          : "1fr",
    )
    .join(" ");

  function handleSortClick(col: ColumnDef<T>) {
    if (!col.sortable || !onSort) return;
    const nextDir: SortDirection =
      sortBy === col.key && sortDir === "asc" ? "desc" : "asc";
    onSort(col.key, nextDir);
  }

  // A full-width row (empty / loading / expanded detail) is still a row with
  // one cell, so the role="table" tree stays valid for screen readers and axe.
  const fullRow = (
    key: React.Key,
    content: React.ReactNode,
    style: React.CSSProperties,
  ) => (
    <div key={key} role="row">
      <div role="cell" aria-colspan={columns.length} style={style}>
        {content}
      </div>
    </div>
  );

  return (
    <div role="table" data-test-id={testId} style={{ width: "100%" }}>
      {/* Header row */}
      <div role="rowgroup">
        <div
          role="row"
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
              // An empty label is not a header (axe empty-table-header): plain cell.
              role={col.label ? "columnheader" : "cell"}
              aria-sort={
                sortBy === col.key
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
              onClick={() => handleSortClick(col)}
              {...(col.sortable && onSort
                ? {
                    tabIndex: 0,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSortClick(col);
                      }
                    },
                  }
                : {})}
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
                <span style={{ fontSize: 9 }}>
                  {sortDir === "asc" ? "▲" : "▼"}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Body rows */}
      <div role="rowgroup">
        {data.length === 0 &&
          !loading &&
          fullRow("empty", emptyMessage, {
            padding: "var(--aiq-space-3xl)",
            textAlign: "center",
            color: "var(--aiq-color-fg-muted)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-md)",
          })}
        {data.map((row, idx) => {
          const key = rowKey ? rowKey(row) : String(idx);
          const extra = rowStyle?.(row);
          const isExpanded =
            renderExpanded != null && expandedId != null && expandedId === key;
          return (
            <React.Fragment key={key}>
              <div
                role="row"
                style={{
                  display: "grid",
                  gridTemplateColumns,
                  padding: "0 var(--aiq-space-md)",
                  borderBottom: "1px solid var(--aiq-color-border)",
                  transition: "background var(--aiq-motion-duration-fast)",
                  ...extra,
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background =
                    "var(--aiq-color-bg-sunken)")
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = String(
                    extra?.background ?? "",
                  ))
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
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[col.key] ?? "")}
                  </div>
                ))}
              </div>
              {isExpanded &&
                renderExpanded &&
                fullRow("detail", renderExpanded(row), {
                  borderBottom: "1px solid var(--aiq-color-border)",
                })}
            </React.Fragment>
          );
        })}
        {loading &&
          fullRow("loading", <Spinner aria-label="Loading" />, {
            padding: "var(--aiq-space-lg)",
            textAlign: "center",
          })}
      </div>

      {/* Load more */}
      {cursor && onLoadMore && !loading && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "var(--aiq-space-md)",
          }}
        >
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
