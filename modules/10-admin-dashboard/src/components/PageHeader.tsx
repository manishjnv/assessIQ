// AssessIQ — shared admin page header: mono eyebrow + serif h1 + muted lede + right slot.
import React from "react";

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
      <div>
        <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
          {eyebrow}
        </div>
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: "4px 0 0", color: "var(--aiq-color-fg-primary)", letterSpacing: "-0.02em" }}>
          {title}
        </h1>
        <p style={{ margin: "6px 0 0", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          {lede}
        </p>
      </div>
      {actions && <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}
