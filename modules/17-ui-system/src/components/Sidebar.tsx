// AssessIQ — Sidebar + NavItem components for the admin shell.
//
// Sidebar: collapsible left navigation panel.
// NavItem: a single nav entry with icon, label, optional badge count.
//
// INVARIANTS (branding-guideline.md):
//  - Uses Geist sans for labels.
//  - Active item background is accent-soft with accent-colored text.
//  - No box-shadow on the sidebar itself at rest.
//  - Width 220px expanded, 56px collapsed.

import React from "react";
import type { IconName } from "./Icon.js";
import { Icon } from "./Icon.js";

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export interface SidebarProps {
  /** Whether the sidebar is collapsed to icon-only mode. */
  collapsed?: boolean;
  /** Callback when the collapse toggle is clicked. */
  onToggle?: () => void;
  children: React.ReactNode;
  "data-test-id"?: string;
}

const SIDEBAR_EXPANDED_W = 220;
const SIDEBAR_COLLAPSED_W = 56;

export function Sidebar({
  collapsed = false,
  onToggle,
  children,
  "data-test-id": testId,
}: SidebarProps): React.ReactElement {
  const w = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W;
  return (
    <aside
      data-test-id={testId}
      style={{
        width: w,
        minWidth: w,
        maxWidth: w,
        height: "100%",
        background: "var(--aiq-color-bg-raised)",
        borderRight: "1px solid var(--aiq-color-border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: "width var(--aiq-motion-duration-base) var(--aiq-motion-easing-out), min-width var(--aiq-motion-duration-base) var(--aiq-motion-easing-out)",
        flexShrink: 0,
      }}
    >
      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-end",
          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--aiq-color-fg-muted)",
          minHeight: 40,
        }}
      >
        <Icon name={collapsed ? "arrow" : "arrowLeft"} size={14} />
      </button>
      <nav style={{ flex: 1, overflowY: "auto", padding: "var(--aiq-space-xs) 0" }}>
        {children}
      </nav>
    </aside>
  );
}

Sidebar.displayName = "Sidebar";

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------

export interface NavItemProps {
  label: string;
  icon?: IconName;
  /** Whether this item is the currently active route. */
  active?: boolean;
  /** Optional badge count (e.g. grading queue depth). */
  badge?: number;
  /** Whether the parent Sidebar is collapsed. */
  collapsed?: boolean;
  onClick?: () => void;
  href?: string;
  "data-test-id"?: string;
}

export function NavItem({
  label,
  icon,
  active = false,
  badge,
  collapsed = false,
  onClick,
  href,
  "data-test-id": testId,
}: NavItemProps): React.ReactElement {
  const content = (
    <>
      {icon && (
        <Icon
          name={icon}
          size={16}
          style={{ flexShrink: 0, color: active ? "var(--aiq-color-accent)" : "inherit" }}
        />
      )}
      {!collapsed && (
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            fontWeight: active ? 500 : 400,
          }}
        >
          {label}
        </span>
      )}
      {!collapsed && badge !== undefined && badge > 0 && (
        <span
          style={{
            background: "var(--aiq-color-accent)",
            color: "#fff",
            borderRadius: "var(--aiq-radius-pill)",
            fontSize: 10,
            fontFamily: "var(--aiq-font-mono)",
            padding: "0 5px",
            minWidth: 18,
            textAlign: "center",
            lineHeight: "18px",
          }}
        >
          {badge}
        </span>
      )}
    </>
  );

  const sharedStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--aiq-space-sm)",
    padding: collapsed
      ? "var(--aiq-space-sm)"
      : "var(--aiq-space-sm) var(--aiq-space-md)",
    justifyContent: collapsed ? "center" : "flex-start",
    background: active ? "var(--aiq-color-accent-soft)" : "none",
    color: active ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-secondary)",
    borderRadius: "var(--aiq-radius-sm)",
    margin: "1px var(--aiq-space-xs)",
    textDecoration: "none",
    cursor: "pointer",
    border: "none",
    width: "calc(100% - var(--aiq-space-xs) * 2)",
    textAlign: "left",
    transition: "background var(--aiq-motion-duration-fast)",
  };

  if (href) {
    return (
      <a href={href} style={sharedStyle} data-test-id={testId} aria-current={active ? "page" : undefined}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} style={sharedStyle} data-test-id={testId} aria-current={active ? "page" : undefined}>
      {content}
    </button>
  );
}

NavItem.displayName = "NavItem";
