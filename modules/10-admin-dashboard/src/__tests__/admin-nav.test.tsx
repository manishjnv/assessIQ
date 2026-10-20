// Z-23 — nav model + TabStrip.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NAV_GROUPS, resolveActiveNav, pathUnder } from "../lib/admin-nav.js";
import { TabStrip } from "../components/TabStrip.js";

afterEach(cleanup);

// Every tenant-admin URL that existed before Z-23 (App.tsx routes) -> [group, tab].
const OLD_URLS: Array<[string, string, string]> = [
  ["/admin", "home", "home"],
  ["/admin/start-test", "assessments", "start-test"],
  ["/admin/assessments", "assessments", "assessments"],
  ["/admin/assessments/abc", "assessments", "assessments"],
  ["/admin/attempts", "assessments", "attempts"],
  ["/admin/attempts/abc", "assessments", "attempts"],
  ["/admin/grading-jobs", "assessments", "grading-status"],
  ["/admin/certificates", "assessments", "certificates"],
  ["/admin/question-bank", "question-bank", "question-bank"],
  ["/admin/question-bank/p1", "question-bank", "question-bank"],
  ["/admin/question-bank/questions/q1", "question-bank", "question-bank"],
  ["/admin/question-import", "question-bank", "question-bank"],
  ["/admin/reports", "reports", "reports"],
  ["/admin/reports/cohort/a1", "reports", "reports"],
  ["/admin/reports/individual/u1", "reports", "reports"],
  ["/admin/activity", "reports", "activity"],
  ["/admin/users", "people", "users"],
  ["/admin/audit-log", "people", "audit-log"],
  ["/admin/integrations/webhooks", "integrations", "webhooks"],
  ["/admin/integrations/embed", "integrations", "embed"],
  ["/admin/settings", "settings", "organisation"],
  ["/admin/tenant-settings", "settings", "organisation"],
];

describe("resolveActiveNav", () => {
  it.each(OLD_URLS)("%s -> group %s, tab %s", (url, group, tab) => {
    const a = resolveActiveNav(url);
    expect(a?.group.id).toBe(group);
    expect(a?.tab.id).toBe(tab);
  });

  it("Settings tabs share one path; ?tab= picks the tab, unknown falls back to the first", () => {
    expect(resolveActiveNav("/admin/settings", "?tab=results")?.tab.id).toBe("results");
    expect(resolveActiveNav("/admin/settings", "?tab=privacy")?.tab.id).toBe("privacy");
    expect(resolveActiveNav("/admin/settings", "?tab=plan")?.tab.id).toBe("plan");
    expect(resolveActiveNav("/admin/settings", "?tab=nope")?.tab.id).toBe("organisation");
  });

  it("is segment-aware and leaves unrelated pages unmatched", () => {
    expect(pathUnder("/admin/users-x", "/admin/users")).toBe(false);
    expect(resolveActiveNav("/admin/settings/help-content")).toBeNull();
    expect(resolveActiveNav("/admin/guide")).toBeNull();
    expect(resolveActiveNav("/admin/platform")).toBeNull();
    expect(resolveActiveNav("/admin/users/")?.tab.id).toBe("users");
  });

  it("has the seven approved groups in order, each group linking to its first tab", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      "Home", "Assessments", "Question bank", "Reports", "People", "Integrations", "Settings",
    ]);
    expect(NAV_GROUPS.find((g) => g.id === "assessments")?.tabs.map((t) => t.label)).toEqual([
      "Assessments", "Start a test", "Attempts", "Grading status", "Certificates",
    ]);
    expect(NAV_GROUPS.find((g) => g.id === "settings")?.tabs.map((t) => t.label)).toEqual([
      "Organisation", "Results", "Data privacy", "Plan and usage",
    ]);
    expect(NAV_GROUPS.find((g) => g.id === "reports")?.tabs.map((t) => t.label)).toEqual(["Reports", "Mock results", "Activity"]);
    expect(NAV_GROUPS.find((g) => g.id === "people")?.tabs.map((t) => t.label)).toEqual(["Users", "Audit log"]);
    expect(NAV_GROUPS.find((g) => g.id === "integrations")?.tabs.map((t) => t.label)).toEqual(["Webhooks", "Embed"]);
  });

  it("every group with more than one tab has a strip; single-tab groups have none", () => {
    for (const g of NAV_GROUPS) expect(Boolean(g.strip), g.id).toBe(g.tabs.length > 1);
  });
});

describe("TabStrip", () => {
  const items = [
    { id: "a", label: "Alpha", href: "/x/a" },
    { id: "b", label: "Beta", href: "/x/b" },
  ];

  it("renders a labelled nav with links; only the active one has aria-current", () => {
    render(
      <MemoryRouter>
        <TabStrip items={items} activeId="b" label="Demo sections" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Demo sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("/x/a");
  });

  it("scrolls sideways", () => {
    render(
      <MemoryRouter>
        <TabStrip items={items} activeId="a" label="Demo sections" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-tabstrip").style.overflowX).toBe("auto");
  });
});
