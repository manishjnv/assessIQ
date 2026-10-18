// AssessIQ — admin navigation model (Z-23).
//
// Seven sidebar groups; each group holds the tabs (existing pages at their
// existing routes). One source of truth for the sidebar, the tab strip and the
// active state. Old URLs are never removed: every admin route that existed
// before Z-23 must resolve to a group (see admin-nav.test.ts).
//
// Role gates: every group below is admin-or-higher, like the RequireSession
// role="admin" guards in apps/web/src/App.tsx. Super-admin-only entries
// (Generate questions, Generation history, Platform) stay in AdminShell.

export type NavIcon = "home" | "chart" | "grid" | "user" | "settings" | "book" | "sparkle" | "clock";

export interface NavTab {
  id: string;
  label: string;
  /** Link target. May carry a query string (Settings tabs share one path). */
  href: string;
  /** Active when the path equals one of these. */
  exact?: readonly string[];
  /** Active when the path is one of these or below it (segment-aware). */
  under?: readonly string[];
  /** Never active for these paths, even if `under` matches. */
  not?: readonly string[];
}

export interface NavGroup {
  id: string;
  label: string;
  icon: NavIcon;
  tabs: readonly NavTab[];
  /** Tab strip is built for this group (Z-23: every group with more than one tab). */
  strip?: boolean;
}

const SETTINGS_PATHS = ["/admin/settings", "/admin/tenant-settings"] as const;
const SETTINGS_NOT = ["/admin/settings/help-content"] as const;
const settingsTab = (id: string, label: string): NavTab => ({
  id,
  label,
  href: `/admin/settings?tab=${id}`,
  under: SETTINGS_PATHS,
  not: SETTINGS_NOT,
});

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "home", label: "Home", icon: "home", tabs: [{ id: "home", label: "Home", href: "/admin", exact: ["/admin"] }] },
  {
    id: "assessments",
    label: "Assessments",
    icon: "clock",
    strip: true,
    tabs: [
      { id: "assessments", label: "Assessments", href: "/admin/assessments", under: ["/admin/assessments"] },
      { id: "start-test", label: "Start a test", href: "/admin/start-test", under: ["/admin/start-test"] },
      { id: "attempts", label: "Attempts", href: "/admin/attempts", under: ["/admin/attempts"] },
      { id: "grading-status", label: "Grading status", href: "/admin/grading-jobs", under: ["/admin/grading-jobs"] },
      { id: "certificates", label: "Certificates", href: "/admin/certificates", under: ["/admin/certificates"] },
    ],
  },
  {
    id: "question-bank",
    label: "Question bank",
    icon: "grid",
    tabs: [
      {
        id: "question-bank",
        label: "Question bank",
        href: "/admin/question-bank",
        under: ["/admin/question-bank", "/admin/question-import"],
      },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "chart",
    strip: true,
    tabs: [
      { id: "reports", label: "Reports", href: "/admin/reports", under: ["/admin/reports"] },
      { id: "activity", label: "Activity", href: "/admin/activity", under: ["/admin/activity"] },
    ],
  },
  {
    id: "people",
    label: "People",
    icon: "user",
    strip: true,
    tabs: [
      { id: "users", label: "Users", href: "/admin/users", under: ["/admin/users"] },
      { id: "audit-log", label: "Audit log", href: "/admin/audit-log", under: ["/admin/audit-log"] },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "sparkle",
    strip: true,
    tabs: [
      { id: "webhooks", label: "Webhooks", href: "/admin/integrations/webhooks", under: ["/admin/integrations/webhooks"] },
      { id: "embed", label: "Embed", href: "/admin/integrations/embed", under: ["/admin/integrations/embed"] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    strip: true,
    tabs: [
      settingsTab("organisation", "Organisation"),
      settingsTab("results", "Results"),
      settingsTab("privacy", "Data privacy"),
      settingsTab("plan", "Plan and usage"),
    ],
  },
];

/** Segment-aware prefix test: "/admin/users" is under "/admin/users/x", not "/admin/users-x". */
export function pathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function tabMatchesPath(tab: NavTab, path: string): boolean {
  if (tab.not?.some((p) => pathUnder(path, p))) return false;
  return Boolean(tab.exact?.includes(path) || tab.under?.some((p) => pathUnder(path, p)));
}

export interface ActiveNav {
  group: NavGroup;
  tab: NavTab;
}

/**
 * Which group and tab does this URL belong to? Null for pages outside the
 * seven groups (Help guide, My account pages, Platform).
 * `search` only matters when several tabs share one path (Settings: ?tab=).
 */
export function resolveActiveNav(pathname: string, search = ""): ActiveNav | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const group of NAV_GROUPS) {
    const hits = group.tabs.filter((t) => tabMatchesPath(t, path));
    if (hits.length === 0) continue;
    const wanted = new URLSearchParams(search).get("tab");
    const tab = (hits.length > 1 && hits.find((t) => t.id === wanted)) || hits[0];
    if (tab) return { group, tab };
  }
  return null;
}
