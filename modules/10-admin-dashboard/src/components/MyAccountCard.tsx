// AssessIQ — "My account" card in the AdminShell sidebar footer (Z-21).
// Presentational: identity, two-factor status chip, one account action, sign out.

import React from "react";
import { Chip } from "@assessiq/ui-system";

export interface MyAccountCardProps {
  initial: string;
  name: string;
  roleLabel: string;
  enrolled: boolean;
  onRegenerate: () => void;
  onEnrol: () => void;
  onSignOut: () => void;
}

const LINK: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
  fontSize: "var(--aiq-text-xs)",
  color: "var(--aiq-color-accent)",
  textDecoration: "underline",
  textAlign: "left",
};

export function MyAccountCard({ initial, name, roleLabel, enrolled, onRegenerate, onEnrol, onSignOut }: MyAccountCardProps): React.ReactElement {
  return (
    <div
      role="group"
      aria-label="My account"
      data-testid="admin-my-account"
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "var(--aiq-radius-pill)",
            background: "var(--aiq-color-accent)",
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            {name}
          </div>
          <div
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              color: "var(--aiq-color-fg-secondary)",
              textTransform: "capitalize",
            }}
          >
            {roleLabel}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)" }}>
        <span>Two-factor sign-in</span>
        <Chip variant={enrolled ? "success" : "default"}>{enrolled ? "On" : "Off"}</Chip>
      </div>
      {enrolled ? (
        <button type="button" style={LINK} onClick={onRegenerate}>Regenerate recovery codes</button>
      ) : (
        <button type="button" style={LINK} onClick={onEnrol}>Set up two-factor sign-in</button>
      )}
      <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={onSignOut}>Sign out</button>
    </div>
  );
}
