// AssessIQ — TabStrip: page-level tabs that are routes (Z-23).
//
// Semantics: <nav aria-label> with links; the current one has aria-current="page".
// Links (not role=tablist) because each tab is its own URL; Tab key moves
// between them, Enter follows. Scrolls sideways on phones.
// Kit Tabs look: underline on the active tab, 13 px labels, tokens only.

import React from "react";
import { Link } from "react-router";

export interface TabStripItem {
  id: string;
  label: string;
  href: string;
}

export interface TabStripProps {
  items: readonly TabStripItem[];
  activeId: string;
  /** Accessible name of the nav landmark, e.g. "Assessments sections". */
  label: string;
}

export function TabStrip({ items, activeId, label }: TabStripProps): React.ReactElement {
  return (
    <nav
      aria-label={label}
      className="aiq-admin-tabstrip"
      data-testid="admin-tabstrip"
      style={{
        display: "flex",
        gap: "var(--aiq-space-lg)",
        overflowX: "auto",
        whiteSpace: "nowrap",
        borderBottom: "1px solid var(--aiq-color-border)",
        marginBottom: "var(--aiq-space-lg)",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {items.map((t) => {
        const active = t.id === activeId;
        return (
          <Link
            key={t.id}
            to={t.href}
            aria-current={active ? "page" : undefined}
            data-testid={`admin-tab-${t.id}`}
            style={{
              flexShrink: 0,
              padding: "var(--aiq-space-sm) 2px",
              minHeight: 36,
              display: "inline-flex",
              alignItems: "center",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              fontWeight: active ? 600 : 500,
              color: active ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-secondary)",
              textDecoration: "none",
              borderBottom: `2px solid ${active ? "var(--aiq-color-accent)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

TabStrip.displayName = "TabStrip";
