// AssessIQ — EmptyState. Kit recipe: design-system/patterns.md "Empty state".
// Centered, 64px vertical padding, muted icon, serif headline, muted body (max 360px), CTA.
import React from "react";

export interface EmptyStateProps {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export function EmptyState({ title, body, action, icon }: EmptyStateProps): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "var(--aiq-space-sm)", padding: "64px var(--aiq-space-md)" }}>
      {icon && <div aria-hidden="true" style={{ color: "var(--aiq-color-fg-muted)" }}>{icon}</div>}
      <h2 className="aiq-serif" style={{ fontSize: 22, margin: 0, color: "var(--aiq-color-fg-primary)" }}>{title}</h2>
      {body && (
        <p style={{ margin: 0, maxWidth: 360, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          {body}
        </p>
      )}
      {action && <div style={{ marginTop: "var(--aiq-space-sm)" }}>{action}</div>}
    </div>
  );
}
EmptyState.displayName = "EmptyState";
