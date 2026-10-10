// AssessIQ — Pagination (1-based).
// Kit gap: no Pagination recipe.
import React from "react";
import { Button } from "./Button.js";

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps): React.ReactElement {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return (
    <nav aria-label="Pagination" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--aiq-space-md)" }}>
      <Button variant="outline" size="sm" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>Previous</Button>
      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
        Page {current} of {pages}
      </span>
      <Button variant="outline" size="sm" disabled={current >= pages} onClick={() => onPageChange(current + 1)}>Next</Button>
    </nav>
  );
}
Pagination.displayName = "Pagination";
