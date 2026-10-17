// AssessIQ — admin help drawer (Z-21).
//
// Mounts HelpDrawerTrigger (button + Ctrl/Cmd+/ shortcut) in the AdminShell top
// bar and a two-tab drawer: "This page" (entries under <helpPage>.) and "Guide"
// (entries under admin.guide., fetched by a nested HelpProvider, so it uses the
// same /api/help hook and only loads once the tab opens).
//
// Help links elsewhere (Grading status, Billing) call openAdminGuide() to open
// the drawer on the Guide tab, via a window event so no prop drilling is needed.

import React, { useEffect, useState } from "react";
import { Drawer } from "@assessiq/ui-system";
import { HelpDrawerTrigger, HelpProvider, useHelpContext } from "@assessiq/help-system/components";

const OPEN_GUIDE_EVENT = "aiq:open-admin-guide";
export const GUIDE_PAGE = "admin.guide";

/** Open the admin help drawer on its Guide tab. No-op when no AdminShell is mounted. */
export function openAdminGuide(): void {
  window.dispatchEvent(new CustomEvent(OPEN_GUIDE_EVENT));
}

// Minimal markdown for trusted help copy: "## " headings, "- " lists, **bold**, blank-line paragraphs.
const inline = (t: string): React.ReactNode[] =>
  t.split(/\*\*(.+?)\*\*/g).map((x, i) => (i % 2 ? <strong key={i}>{x}</strong> : x));

function Md({ text }: { text: string }): React.ReactElement {
  const style = { margin: "0 0 var(--aiq-space-xs)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" } as const;
  return (
    <>
      {text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- "))) {
          return (
            <ul key={i} style={{ ...style, paddingLeft: "var(--aiq-space-lg)" }}>
              {lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}
            </ul>
          );
        }
        if (b.startsWith("## ")) {
          const rest = lines.slice(1).join(" ");
          return (
            <React.Fragment key={i}>
              <h4 style={{ ...style, fontWeight: 600 }}>{lines[0]!.slice(3)}</h4>
              {rest && <p style={style}>{inline(rest)}</p>}
            </React.Fragment>
          );
        }
        return <p key={i} style={style}>{inline(lines.join(" "))}</p>;
      })}
    </>
  );
}

function EntryList({ prefix, emptyText }: { prefix: string; emptyText: string }): React.ReactElement {
  const { entries, loading } = useHelpContext();
  const rows = [...entries.values()]
    .filter((e) => e.key.startsWith(prefix))
    .sort((a, b) => {
      // The page-level entry first, then the rest by key.
      const ap = a.key.endsWith(".page") ? 0 : 1;
      const bp = b.key.endsWith(".page") ? 0 : 1;
      return ap - bp || a.key.localeCompare(b.key);
    });
  if (rows.length === 0) {
    return (
      <p style={{ margin: 0, color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>
        {loading ? "Loading…" : emptyText}
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {rows.map((e) => (
        <section key={e.key} data-help-key={e.key}>
          <h3 style={{ margin: "0 0 4px", fontSize: "var(--aiq-text-md)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
            {e.shortText}
          </h3>
          {e.longMd && (
            <Md text={e.longMd} />
          )}
        </section>
      ))}
    </div>
  );
}

type Tab = "page" | "guide";

/** Must render inside a HelpProvider (AdminShell always provides one). */
export function AdminHelp(): React.ReactElement {
  const { page, drawerOpenKey, openDrawer, closeDrawer } = useHelpContext();
  const [tab, setTab] = useState<Tab>("page");

  useEffect(() => {
    const onOpenGuide = (): void => {
      setTab("guide");
      openDrawer(`${page}.page`);
    };
    window.addEventListener(OPEN_GUIDE_EVENT, onOpenGuide);
    return () => window.removeEventListener(OPEN_GUIDE_EVENT, onOpenGuide);
  }, [page, openDrawer]);

  const close = (): void => {
    closeDrawer();
    setTab("page");
  };

  const tabButton = (id: Tab, label: string): React.ReactElement => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        background: "none",
        border: "none",
        borderBottom: `2px solid ${tab === id ? "var(--aiq-color-accent)" : "transparent"}`,
        padding: "var(--aiq-space-xs) var(--aiq-space-md)",
        cursor: "pointer",
        font: "inherit",
        fontSize: "var(--aiq-text-sm)",
        color: tab === id ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-muted)",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <HelpDrawerTrigger testId="admin-help-trigger" />
      <Drawer open={drawerOpenKey !== null} onClose={close} title="Help" width={480} data-test-id="admin-help-drawer">
        <div role="tablist" aria-label="Help sections" style={{ display: "flex", marginBottom: "var(--aiq-space-lg)", borderBottom: "1px solid var(--aiq-color-border)" }}>
          {tabButton("page", "This page")}
          {tabButton("guide", "Guide")}
        </div>
        {tab === "page" ? (
          <EntryList prefix={`${page}.`} emptyText="No help for this page yet. Open the Guide tab." />
        ) : (
          <HelpProvider page={GUIDE_PAGE} audience="admin">
            <EntryList prefix={`${GUIDE_PAGE}.`} emptyText="The guide is not available right now." />
          </HelpProvider>
        )}
      </Drawer>
    </>
  );
}
