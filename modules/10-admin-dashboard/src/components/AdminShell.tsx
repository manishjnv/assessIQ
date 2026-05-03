// AssessIQ — AdminShell component.
//
// The persistent layout wrapper for every admin page:
//   - Left Sidebar with role-aware nav items
//   - Top bar with tenant name, help trigger, profile menu
//   - Main content area with breadcrumbs
//
// HelpProvider is wired at the /admin root here so all nested pages
// automatically get tooltip/drawer support without per-page setup.
//
// INVARIANTS:
//  - Light mode only (ThemeProvider theme="light" is in App.tsx).
//  - Sidebar filter state in sessionStorage only (no localStorage).
//  - No claude/anthropic imports.

import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Sidebar, NavItem } from "@assessiq/ui-system";
import { HelpProvider } from "@assessiq/help-system/components";
import { useAdminSession, adminLogout } from "../session.js";

export interface AdminShellProps {
  children: React.ReactNode;
  /** Breadcrumb segments — e.g. ["Attempts", "Detail"]. */
  breadcrumbs?: string[];
  /** Help page key e.g. "admin.grading.queue". */
  helpPage?: string;
}

function sidebarCollapsedKey(tenantId: string): string {
  // sessionStorage key — scoped to tenant to prevent cross-tenant leakage.
  return `aiq.admin.sidebar.collapsed.${tenantId}`;
}

export function AdminShell({ children, breadcrumbs, helpPage }: AdminShellProps): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useAdminSession();
  const tenantId = session?.tenant.id ?? "unknown";

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(sidebarCollapsedKey(tenantId)) === "true";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      sessionStorage.setItem(sidebarCollapsedKey(tenantId), String(next));
    } catch {
      // sessionStorage unavailable — ignore
    }
  }

  const path = location.pathname;

  // Nav config — role-aware: reviewers see grading + reports only.
  const isAdmin = session?.user.role === "admin";

  interface NavEntry {
    label: string;
    href: string;
    icon: "home" | "chart" | "grid" | "user" | "settings" | "book" | "bell" | "eye";
    adminOnly?: boolean;
  }

  const navEntries: NavEntry[] = [
    { label: "Dashboard", href: "/admin", icon: "home" },
    { label: "Attempts", href: "/admin/attempts", icon: "eye" },
    { label: "Grading", href: "/admin/grading-jobs", icon: "chart" },
    { label: "Reports", href: "/admin/reports/cohort", icon: "chart" },
    { label: "Question Bank", href: "/admin/question-bank/packs", icon: "book", adminOnly: true },
    { label: "Users", href: "/admin/users", icon: "user", adminOnly: true },
    { label: "Settings", href: "/admin/settings/billing", icon: "settings", adminOnly: true },
  ];

  async function handleLogout() {
    await adminLogout();
    navigate("/admin/login");
  }

  const content = (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--aiq-color-bg-base)",
      }}
    >
      {/* Sidebar */}
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed}>
        {navEntries
          .filter((e) => !e.adminOnly || isAdmin)
          .map((e) => (
            <NavItem
              key={e.href}
              label={e.label}
              icon={e.icon}
              href={e.href}
              active={path === e.href || (e.href !== "/admin" && path.startsWith(e.href))}
              collapsed={collapsed}
            />
          ))}
      </Sidebar>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 var(--aiq-space-xl)",
            height: 52,
            borderBottom: "1px solid var(--aiq-color-border)",
            flexShrink: 0,
            background: "var(--aiq-color-bg-raised)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              AssessIQ
            </span>
            {session?.tenant.slug && (
              <>
                <span style={{ color: "var(--aiq-color-border-strong)" }}>/</span>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-accent)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {session.tenant.slug}
                </span>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
            <span
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-secondary)",
              }}
            >
              {session?.user.email}
            </span>
            <button
              type="button"
              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
              onClick={() => void handleLogout()}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div
            style={{
              padding: "var(--aiq-space-sm) var(--aiq-space-xl)",
              borderBottom: "1px solid var(--aiq-color-border)",
              background: "var(--aiq-color-bg-raised)",
              display: "flex",
              alignItems: "center",
              gap: "var(--aiq-space-xs)",
              flexShrink: 0,
            }}
          >
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: "var(--aiq-color-fg-muted)", fontSize: 12 }}>/</span>}
                <span
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    color: i === breadcrumbs.length - 1 ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-muted)",
                  }}
                >
                  {crumb}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Page content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "var(--aiq-space-xl)",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );

  if (helpPage) {
    return (
      <HelpProvider page={helpPage} audience="admin">
        {content}
      </HelpProvider>
    );
  }
  return content;
}

AdminShell.displayName = "AdminShell";
