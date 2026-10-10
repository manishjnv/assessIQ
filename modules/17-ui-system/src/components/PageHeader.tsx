// AssessIQ — PageHeader: serif h1 + optional count chip + lede, actions on the right.
// Kit recipe: design-system/patterns.md "Page header recipe (universal)".
import React from "react";
import { Chip } from "./Chip.js";

export interface PageHeaderProps {
  title: string;
  count?: number;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, count, lede, actions }: PageHeaderProps): React.ReactElement {
  return (
    <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <h1 className="aiq-serif" style={{ fontSize: "var(--aiq-text-3xl)", margin: 0, color: "var(--aiq-color-fg-primary)" }}>
            {title}
          </h1>
          {count !== undefined && <Chip>{count}</Chip>}
        </div>
        {lede && (
          <p style={{ margin: "6px 0 0", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            {lede}
          </p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
    </header>
  );
}
PageHeader.displayName = "PageHeader";
