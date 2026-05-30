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

import React, { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Icon, Sidebar, NavItem, SidebarSection, useViewport } from "@assessiq/ui-system";
import { HelpProvider } from "@assessiq/help-system/components";
import { useAdminSession, adminLogout } from "../session.js";

/**
 * Breadcrumb segment — either a plain string (non-clickable label) or
 * `{ label, href }` for a clickable parent segment. The last segment in the
 * array is treated as the current page and is never clickable regardless of
 * whether an `href` is provided.
 */
export type BreadcrumbSegment = string | { label: string; href: string };

export interface AdminShellProps {
  children: React.ReactNode;
  /** Breadcrumb segments — e.g. `["Attempts", "Detail"]` or `[{label:"Attempts", href:"/admin/attempts"}, "Detail"]`. */
  breadcrumbs?: BreadcrumbSegment[];
  /** Help page key e.g. "admin.grading.queue". */
  helpPage?: string;
}

function sidebarCollapsedKey(tenantId: string): string {
  // sessionStorage key — scoped to tenant to prevent cross-tenant leakage.
  return `aiq.admin.sidebar.collapsed.${tenantId}`;
}

const MFA_NUDGE_DISMISSED_KEY = "aiq.admin.mfa-nudge-dismissed";

function MfaNudgeBanner({
  onDismiss,
  onSetup,
}: {
  onDismiss: () => void;
  onSetup: () => void;
}): React.ReactElement {
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
        <button
          type="button"
          onClick={onSetup}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "inherit",
            color: "var(--aiq-color-accent)",
            fontWeight: 500,
            textDecoration: "underline",
          }}
        >
          Set up authenticator &rarr;
        </button>
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

  const viewport = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Close drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Drawer lifecycle: Escape, body scroll lock, focus capture+trap+restore.
  // Spec § 5 #11 — modal overlays must trap focus.
  useEffect(() => {
    if (!drawerOpen) return;

    // (a) Capture currently-focused element so we can restore it on close.
    lastFocusedRef.current = document.activeElement as HTMLElement | null;

    // (b) Move focus into the drawer's first focusable child.
    // requestAnimationFrame ensures the drawer node is mounted + visible.
    const focusFirst = () => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = drawer.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    // (c) Trap Tab/Shift-Tab inside the drawer.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // narrow HTMLElement | undefined (noUncheckedIndexedAccess); the length>0 guard above guarantees both exist at runtime
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      // (d) Restore focus to the element that opened the drawer.
      lastFocusedRef.current?.focus?.();
    };
  }, [drawerOpen]);

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

  // Nav split into four sections (2026-05-20 IA reorg):
  //   Workspace — the assessment lifecycle pipeline (Dashboard + design→take→grade→report)
  //   Library   — question-bank surface (catalogue + AI generation + history)
  //   Admin     — management / audit (users, activity log)
  //   Account   — help, settings, super-admin platform
  // The previous 10-item flat WORKSPACE list was scan-heavy; four sub-headers
  // group items by intent without introducing collapsibles (lowest-risk reorg).
  // Role filtering (adminOnly / superAdminOnly) is applied per section by the
  // shared renderEntries helper below.
  const workspaceEntries: NavEntry[] = [
    { label: "Dashboard", href: "/admin", icon: "home" },
    { label: "Assessments", href: "/admin/assessments", icon: "clock", adminOnly: true },
    { label: "Attempts", href: "/admin/attempts", icon: "eye" },
    { label: "Grading", href: "/admin/grading-jobs", icon: "chart" },
    { label: "Reports", href: "/admin/reports", icon: "sparkle", adminOnly: true },
    { label: "Certificates", href: "/admin/certificates", icon: "book", adminOnly: true },
  ];

  // Library — question-bank surface. Phase B1: generation history + generate
  // wizard remain super_admin-only (FE defense-in-depth; backend Part 4 is
  // authoritative). "AI generation history" renamed to "Generation history"
  // for nav consistency (Activity is also a history; "AI" prefix is implied
  // by living inside the Library section).
  const libraryEntries: NavEntry[] = [
    { label: "Question Bank", href: "/admin/question-bank", icon: "grid", adminOnly: true },
    { label: "Generate Questions", href: "/admin/generate-wizard", icon: "sparkle", superAdminOnly: true },
    { label: "Generation history", href: "/admin/generation-attempts", icon: "sparkle", superAdminOnly: true },
  ];

  // Admin — management + audit. Users moved out of Workspace (it's a
  // management task, not a daily workspace activity). Activity (audit log)
  // joins it as a sibling — both are management/oversight surfaces.
  const adminEntries: NavEntry[] = [
    { label: "Users", href: "/admin/users", icon: "user", adminOnly: true },
    { label: "Activity", href: "/admin/activity", icon: "chart", adminOnly: true },
  ];

  const accountEntries: NavEntry[] = [
    { label: "Help guide", href: "/admin/guide", icon: "book" },
    // Settings hosts billing + DPDP retention controls (tenant-settings is
    // embedded as a section at the bottom of the billing page).
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
      className="aiq-screen aiq-admin-shell"
      data-drawer-open={drawerOpen ? "true" : "false"}
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--aiq-color-bg-base)",
      }}
    >
      {/* Drawer backdrop — mobile only, only when open. Click closes. */}
      {drawerOpen && (
        <div
          data-testid="admin-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          className="aiq-admin-drawer-backdrop"
          aria-hidden="true"
        />
      )}

      {/* Sidebar — wrapped in aiq-admin-sidebar-wrap so mobile CSS can
          position it off-canvas without the primitive knowing.
          drawerRef is consumed by the focus-trap effect when drawerOpen. */}
      <div
        ref={drawerRef}
        className="aiq-admin-sidebar-wrap"
        role={drawerOpen ? "dialog" : undefined}
        aria-label={drawerOpen ? "Navigation" : undefined}
        aria-modal={drawerOpen ? "true" : undefined}
      >
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} footer={sidebarFooter}>
          {(() => {
            // Shared filter — adminOnly + superAdminOnly gates are identical
            // across all sections; extracted to keep each section a one-liner.
            const visible = (e: NavEntry): boolean =>
              (!e.adminOnly || isAdmin) &&
              (!e.superAdminOnly || session?.user.role === "super_admin");
            const renderEntry = (e: NavEntry): JSX.Element => (
              <NavItem
                key={e.href}
                label={e.label}
                icon={e.icon}
                href={e.href}
                active={path === e.href || (e.href !== "/admin" && path.startsWith(e.href))}
                collapsed={collapsed}
              />
            );
            // Render a section header only if at least one of its entries is
            // visible to the current role — avoids an empty "Admin" label for
            // a reviewer who has no admin entries.
            const renderSection = (label: string, entries: NavEntry[]): JSX.Element | null => {
              const shown = entries.filter(visible);
              if (shown.length === 0) return null;
              return (
                <Fragment key={label}>
                  <SidebarSection label={label} collapsed={collapsed} />
                  {shown.map(renderEntry)}
                </Fragment>
              );
            };
            return (
              <>
                {renderSection("Workspace", workspaceEntries)}
                {renderSection("Library", libraryEntries)}
                {renderSection("Admin", adminEntries)}
                {renderSection("Account", accountEntries)}
              </>
            );
          })()}
        </Sidebar>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 var(--aiq-admin-shell-topbar-padding-x)",
            height: "var(--aiq-admin-shell-topbar-h)",
            borderBottom: "1px solid var(--aiq-color-border)",
            flexShrink: 0,
            background: "var(--aiq-color-bg-raised)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
            {/* Hamburger — mobile-additive overlay (anti-pattern guard #1 carve-out).
                Render gated by useViewport() hook so resize-driven viewport changes
                trigger a re-render. Defense-in-depth: tokens.css also has
                .aiq-admin-hamburger { display: none } on desktop. */}
            {viewport === "mobile" && (
              <button
                type="button"
                className="aiq-admin-hamburger"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                data-help-id="admin.shell.nav.mobile_menu"
                style={{
                  background: "none",
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-pill)",
                  width: 32,
                  height: 32,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <Icon name="drag" size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate("/admin")}
              aria-label="Go to dashboard"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              AssessIQ
            </button>
            {session?.tenant.slug && (
              <span className="aiq-admin-shell-slug">
                <span style={{ color: "var(--aiq-color-border-strong)" }}>/</span>
                <button
                  type="button"
                  onClick={() => navigate("/admin")}
                  aria-label={`${session.tenant.slug} — go to dashboard`}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    font: "inherit",
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-accent)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {session.tenant.slug}
                </button>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
            <span
              className="aiq-admin-shell-email"
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
          <div className="aiq-admin-mfa-nudge">
            <MfaNudgeBanner onDismiss={dismissNudge} onSetup={() => navigate("/admin/mfa")} />
          </div>
        )}

        {/* Breadcrumbs — last segment is current page (never clickable). Earlier
            segments are clickable when supplied as `{label, href}` so users can
            navigate up; plain string segments stay as non-clickable labels for
            backward compatibility with callers that pre-date the typed form. */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div
            className="aiq-admin-breadcrumbs"
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
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              const label = typeof crumb === "string" ? crumb : crumb.label;
              const href = typeof crumb === "string" ? undefined : crumb.href;
              const baseStyle = {
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: isLast ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-muted)",
              } as const;
              return (
                <React.Fragment key={i}>
                  {i > 0 && <span style={{ color: "var(--aiq-color-fg-muted)", fontSize: 12 }}>/</span>}
                  {href && !isLast ? (
                    <button
                      type="button"
                      onClick={() => navigate(href)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        textDecoration: "underline",
                        ...baseStyle,
                      }}
                    >
                      {label}
                    </button>
                  ) : (
                    <span style={baseStyle}>{label}</span>
                  )}
                </React.Fragment>
              );
            })}
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
