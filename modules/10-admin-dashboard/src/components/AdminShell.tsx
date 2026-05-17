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
import { Sidebar, NavItem, SidebarSection } from "@assessiq/ui-system";
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

const MFA_NUDGE_DISMISSED_KEY = "aiq.admin.mfa-nudge-dismissed";

function MfaNudgeBanner({ onDismiss }: { onDismiss: () => void }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--aiq-space-md)",
        padding: "10px var(--aiq-space-xl)",
        background: "var(--aiq-color-warning-bg, #fefce8)",
        borderBottom: "1px solid var(--aiq-color-warning-border, #fde68a)",
        flexShrink: 0,
      }}
      role="alert"
      aria-label="MFA enrollment recommended"
    >
      <span
        style={{
          fontFamily: "var(--aiq-font-sans)",
          fontSize: "var(--aiq-text-sm)",
          color: "var(--aiq-color-fg-primary)",
          flex: 1,
        }}
      >
        <strong>Secure your account.</strong> Enable two-factor authentication to protect against unauthorised access.{" "}
        <a
          href="/admin/mfa"
          style={{
            color: "var(--aiq-color-accent)",
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          Set up authenticator &rarr;
        </a>
      </span>
      <button
        type="button"
        aria-label="Dismiss MFA enrollment reminder"
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
          fontFamily: "var(--aiq-font-mono)",
          fontSize: "var(--aiq-text-xs)",
          color: "var(--aiq-color-fg-muted)",
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
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

  const [nudgeDismissed, setNudgeDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(MFA_NUDGE_DISMISSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  function dismissNudge() {
    setNudgeDismissed(true);
    try {
      sessionStorage.setItem(MFA_NUDGE_DISMISSED_KEY, "true");
    } catch {
      // sessionStorage unavailable — ignore
    }
  }

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
  // super_admin satisfies the admin gate (super_admin > admin).
  const isAdmin = session?.user.role === "admin" || session?.user.role === "super_admin";

  interface NavEntry {
    label: string;
    href: string;
    icon: "home" | "chart" | "grid" | "user" | "settings" | "book" | "bell" | "eye" | "clock" | "sparkle";
    adminOnly?: boolean;
    /**
     * When true, the entry is shown ONLY to super_admin sessions.
     * A tenant admin (role === "admin") must NOT see these entries — super_admin
     * is not a peer of admin, it is a platform-level role above the tenant
     * hierarchy. This gate is FE defense-in-depth; the backend remains the real
     * boundary.
     */
    superAdminOnly?: boolean;
  }

  // Nav split: Workspace (create/run/review) → Account (help + settings)
  // kit dashboard.jsx: SidebarSection "Workspace" then "Account"
  const workspaceEntries: NavEntry[] = [
    { label: "Dashboard", href: "/admin", icon: "home" },
    { label: "Assessments", href: "/admin/assessments", icon: "clock", adminOnly: true },
    { label: "Attempts", href: "/admin/attempts", icon: "eye" },
    { label: "Grading", href: "/admin/grading-jobs", icon: "chart" },
    { label: "Reports", href: "/admin/reports", icon: "sparkle", adminOnly: true },
    { label: "Activity", href: "/admin/activity", icon: "chart", adminOnly: true },
    { label: "AI generation history", href: "/admin/generation-attempts", icon: "sparkle", adminOnly: true },
    { label: "Question Bank", href: "/admin/question-bank", icon: "grid", adminOnly: true },
    { label: "Generate Questions", href: "/admin/generate-wizard", icon: "sparkle", adminOnly: true },
    { label: "Users", href: "/admin/users", icon: "user", adminOnly: true },
  ];

  const accountEntries: NavEntry[] = [
    { label: "Help guide", href: "/admin/guide", icon: "book" },
    { label: "Settings", href: "/admin/settings/billing", icon: "settings", adminOnly: true },
    // Platform provisioning — visible to super_admin only; tenant admins must not see this.
    { label: "Platform", href: "/admin/platform", icon: "settings", superAdminOnly: true },
  ];

  // User card footer — kit dashboard.jsx footer slot
  const userInitial = (session?.user.email ?? "A").charAt(0).toUpperCase();
  const userDisplayName = session?.user.email?.split("@")[0] ?? "";
  const userRoleLabel =
    session?.user.role === "super_admin"
      ? "Super admin"
      : session?.user.role === "admin"
        ? "Admin"
        : "Reviewer";

  const sidebarFooter = (
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
        {userInitial}
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
          {userDisplayName}
        </div>
        <div
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: 10,
            color: "var(--aiq-color-fg-secondary)",
            textTransform: "capitalize",
          }}
        >
          {userRoleLabel}
        </div>
      </div>
    </div>
  );

  async function handleLogout() {
    await adminLogout();
    navigate("/admin/login");
  }

  const content = (
    <div
      className="aiq-screen"
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--aiq-color-bg-base)",
      }}
    >
      {/* Sidebar */}
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} footer={sidebarFooter}>
        <SidebarSection label="Workspace" collapsed={collapsed} />
        {workspaceEntries
          .filter((e) => (!e.adminOnly || isAdmin) && (!e.superAdminOnly || session?.user.role === "super_admin"))
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
        <SidebarSection label="Account" collapsed={collapsed} />
        {accountEntries
          .filter((e) => (!e.adminOnly || isAdmin) && (!e.superAdminOnly || session?.user.role === "super_admin"))
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

        {/* MFA enrollment nudge — shown once per session for unenrolled admins/reviewers */}
        {session?.totpEnrolled === false && !nudgeDismissed && (
          <MfaNudgeBanner onDismiss={dismissNudge} />
        )}

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
