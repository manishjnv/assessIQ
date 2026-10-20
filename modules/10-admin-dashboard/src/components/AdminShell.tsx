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
import { Button, Icon, Modal, Sidebar, NavItem, SidebarSection, TenantLogo, useViewport } from "@assessiq/ui-system";
import { HelpProvider } from "@assessiq/help-system/components";
import { useAdminSession, adminLogout } from "../session.js";
import { NotificationBell } from "./NotificationBell.js";
import { AdminHelp } from "./AdminHelp.js";
import { MyAccountCard } from "./MyAccountCard.js";
import { RegenerateCodesModal } from "./RegenerateCodesModal.js";
import { TabStrip } from "./TabStrip.js";
import { NAV_GROUPS, resolveActiveNav, type NavIcon } from "../lib/admin-nav.js";
import { useCameraReviewer } from "../lib/camera-reviewer.js";

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
        <strong>Secure your account.</strong> Turn on two-step sign-in to protect your account.{" "}
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

  const [regenOpen, setRegenOpen] = useState(false);
  const [newCodes, setNewCodes] = useState<string[]>([]);

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

  // Camera feature: reviewer probe (hidden on 403 or error).
  const cameraReviewer = useCameraReviewer(session?.user.id);

  const path = location.pathname;

  // Nav config — role-aware (admin vs super_admin entries).
  // super_admin satisfies the admin gate (super_admin > admin).
  const isAdmin = session?.user.role === "admin" || session?.user.role === "super_admin";

  interface NavEntry {
    label: string;
    href: string;
    icon: NavIcon | "check" | "book" | "eye";
    /** A nested route that has its own nav entry — this entry is not active on it. */
    excludePath?: string;
    /**
     * When true, the entry is shown ONLY to super_admin sessions.
     * A tenant admin (role === "admin") must NOT see these entries — super_admin
     * is not a peer of admin, it is a platform-level role above the tenant
     * hierarchy. This gate is FE defense-in-depth; the backend remains the real
     * boundary.
     */
    superAdminOnly?: boolean;
    /** Camera feature: shown only when the camera reviewer probe succeeds (super admin passes too). */
    cameraReviewerOnly?: boolean;
  }

  // Z-23 (2026-10-18): seven tenant-admin groups from lib/admin-nav.ts. Each
  // group links to its first tab and is active on any URL under one of its tabs
  // (resolveActiveNav). Every group is admin-or-higher, matching the
  // RequireSession role="admin" guards in apps/web/src/App.tsx. Z-21 moved Help
  // guide and Account security to the help drawer and My account card.
  const activeNav = resolveActiveNav(path, location.search);
  const groupEntries: NavEntry[] = NAV_GROUPS.map((g) => ({
    label: g.label,
    href: g.tabs[0]?.href ?? "/admin",
    icon: g.icon,
  }));

  // Content — AI question generation, super_admin only (backend Part 4 is authoritative).
  const contentEntries: NavEntry[] = [
    { label: "Generate questions", href: "/admin/generate-wizard", icon: "sparkle", superAdminOnly: true },
    { label: "Generation history", href: "/admin/generation-attempts", icon: "sparkle", superAdminOnly: true },
    { label: "Exam blueprints", href: "/admin/exam-blueprints", icon: "book", superAdminOnly: true },
  ];

  // Review — camera reviewers (named tenant admins and super admins).
  const reviewEntries: NavEntry[] = [
    { label: "Camera review", href: "/admin/camera-review", icon: "eye", cameraReviewerOnly: true },
  ];

  // Platform — super_admin-only surfaces (RW-16), split out of Account.
  const platformEntries: NavEntry[] = [
    // Evaluation queue — AssessIQ's cross-tenant AI-evaluation work surface
    // (super_admin only; tenant admins review and publish, they never evaluate).
    { label: "Grading queue", href: "/admin/platform/evaluations", icon: "check", superAdminOnly: true },
    // Platform provisioning — visible to super_admin only; tenant admins must not see this.
    { label: "Platform", href: "/admin/platform", icon: "settings", superAdminOnly: true, excludePath: "/admin/platform/evaluations" },
    // Help content authoring — platform only (FR14 owner decision 2026-10-03; FU-D3).
    // The route stays admin-reachable for company overrides (dormant feature).
    { label: "Help content", href: "/admin/settings/help-content", icon: "book", superAdminOnly: true },
  ];

  // User card footer — kit dashboard.jsx footer slot
  const userInitial = (session?.user.email ?? "A").charAt(0).toUpperCase();
  const userDisplayName = session?.user.email?.split("@")[0] ?? "";
  const userRoleLabel =
    session?.user.role === "super_admin"
      ? "Super admin"
      : session?.user.role === "admin"
        ? "Admin"
        : "User";

  const enrolled = session?.totpEnrolled === true;
  // My account card (Z-21): identity, two-factor status, recovery codes, sign out.
  const sidebarFooter = (
    <MyAccountCard
      initial={userInitial}
      name={userDisplayName}
      email={session?.user.email}
      roleLabel={userRoleLabel}
      enrolled={enrolled}
      onRegenerate={() => setRegenOpen(true)}
      onEnrol={() => navigate("/admin/mfa")}
      onSignOut={() => void handleLogout()}
    />
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
      {/* Z-6: print every page of a review. The screen layout is a fixed-height
          scroll container (height 100vh, overflow hidden); release it for print and
          hide the chrome. !important beats the inline styles. */}
      <style>{`
        @media print {
          html, body { height: auto !important; overflow: visible !important; }
          .aiq-admin-shell, .aiq-admin-main-col, .aiq-admin-main {
            display: block !important;
            height: auto !important;
            overflow: visible !important;
          }
          .aiq-admin-sidebar-wrap, .aiq-admin-topbar, .aiq-admin-mfa-nudge,
          .aiq-admin-breadcrumbs, .aiq-admin-drawer-backdrop { display: none !important; }
        }
      `}</style>

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
              !e.superAdminOnly || session?.user.role === "super_admin";
            const renderEntry = (e: NavEntry, groupId?: string): React.JSX.Element => (
              <NavItem
                key={e.href}
                label={e.label}
                icon={e.icon}
                href={e.href}
                active={
                  groupId
                    ? activeNav?.group.id === groupId
                    : path === e.href ||
                      (path.startsWith(e.href) && !(e.excludePath && path.startsWith(e.excludePath)))
                }
                collapsed={collapsed}
              />
            );
            // Render a section header only if at least one entry is visible to the role.
            const renderSection = (label: string, entries: NavEntry[]): React.JSX.Element | null => {
              const shown = entries.filter((e) => visible(e) && (!e.cameraReviewerOnly || cameraReviewer));
              if (shown.length === 0) return null;
              return (
                <Fragment key={label}>
                  <SidebarSection label={label} collapsed={collapsed} />
                  {shown.map((e) => renderEntry(e))}
                </Fragment>
              );
            };
            return (
              <>
                {isAdmin && groupEntries.map((e, i) => renderEntry(e, NAV_GROUPS[i]?.id))}
                {renderSection("Content", contentEntries)}
                {renderSection("Review", reviewEntries)}
                {renderSection("Platform", platformEntries)}
              </>
            );
          })()}
        </Sidebar>
      </div>

      {/* Main */}
      <div className="aiq-admin-main-col" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <header
          className="aiq-admin-topbar"
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
                  aria-label={`${session.tenant.name ?? session.tenant.slug} — go to dashboard`}
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
                  <span data-help-id="admin.shell.tenant_logo" style={{ display: "inline-flex" }}>
                    <TenantLogo
                      src={session.tenant.logo_url ?? null}
                      name={session.tenant.name ?? session.tenant.slug}
                      height={28}
                      viaAssessIQ
                    />
                  </span>
                </button>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
            <AdminHelp />
            <NotificationBell />
            {/* Account identity and Sign out live in the sidebar account card only (one place). */}
          </div>
        </header>

        {/* MFA enrollment nudge — shown once per session for unenrolled admins */}
        {session?.totpEnrolled === false && !nudgeDismissed && (
          <section className="aiq-admin-mfa-nudge" aria-label="Security notice">
            <MfaNudgeBanner onDismiss={dismissNudge} onSetup={() => navigate("/admin/mfa")} />
          </section>
        )}

        {/* Breadcrumbs — last segment is current page (never clickable). Earlier
            segments are clickable when supplied as `{label, href}` so users can
            navigate up; plain string segments stay as non-clickable labels for
            backward compatibility with callers that pre-date the typed form. */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
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
          </nav>
        )}

        {/* Page content */}
        <main
          className="aiq-admin-main"
          tabIndex={0}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "var(--aiq-space-xl)",
          }}
        >
          {activeNav?.group.strip && (
            <TabStrip
              label={`${activeNav.group.label} sections`}
              items={activeNav.group.tabs}
              activeId={activeNav.tab.id}
            />
          )}
          {children}
        </main>
      </div>

      <RegenerateCodesModal open={regenOpen} onClose={() => setRegenOpen(false)} onCodes={setNewCodes} />
      <Modal open={newCodes.length > 0} onClose={() => setNewCodes([])} title="Your new recovery codes">
        <p style={{ margin: "0 0 12px", fontSize: "var(--aiq-text-sm)" }}>
          These backup codes show <strong>once only</strong>. Each code works one time if you lose your authenticator app. Your old codes no longer work.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "var(--aiq-space-sm)",
            padding: "var(--aiq-space-md)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            marginBottom: "var(--aiq-space-md)",
          }}
        >
          {newCodes.map((c) => (
            <code key={c} style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)" }}>{c}</code>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={() => setNewCodes([])}>I saved them</Button>
        </div>
      </Modal>
    </div>
  );

  // Always provide a HelpProvider: the top-bar help drawer needs one. Pages without
  // a helpPage (e.g. /admin/guide) fall back to the shell's own key family.
  return (
    <HelpProvider page={helpPage ?? "admin.shell"} audience="admin">
      {content}
    </HelpProvider>
  );
}

AdminShell.displayName = "AdminShell";
