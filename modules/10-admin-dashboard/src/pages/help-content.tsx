// AssessIQ — Admin help content management page.
//
// /admin/settings/help-content
//
// FU-D1 (2026-10-06): aligned to the real routes (RV74 found the page called
// four paths that never existed). FU-D2: the super admin edits the GLOBAL row
// (a new version); a company admin edits a company override. FR14 owner
// decision 2026-10-03: help editing is platform only, so the menu entry is
// super-admin only (FU-D3); the company-override route stays (dormant feature).
//
// Consumes:
//   GET   /api/admin/help?locale=            → { entries: HelpEntry[] } (newest version per row)
//   PATCH /api/admin/help/global/:key        → super admin: new global version
//   PATCH /api/admin/help/:key               → company admin: company override
//   GET   /api/admin/help/export?locale=     → HelpEntry[] (download JSON)
//   POST  /api/admin/help/import?locale=     → { rows: [{ key, input }] }
//
// Markdown preview shown as plain text (no renderer — avoids XSS risk).
//
// INVARIANTS:
//  - key is immutable (platform-defined). Edits change short_text, long_md, audience.
//  - No dangerouslySetInnerHTML.
//
// Kit: page header (serif h1 + lede), search input, card rows, Modal
// (components.md / patterns.md). Diverges from no kit screen: there is no
// help-authoring screen in screens/; the layout reuses users.tsx row cards.

import React, { useEffect, useState, useCallback } from "react";
import { Chip, Modal, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";
import { useAdminSession } from "../session.js";

type Audience = "admin" | "candidate" | "all" | "reviewer";

interface HelpEntry {
  id: string;
  tenantId: string | null;
  key: string;
  audience: Audience;
  locale: string;
  shortText: string;
  longMd: string | null;
  version: number;
  status: "active" | "archived";
  updatedAt: string;
}

interface HelpListResponse {
  entries: HelpEntry[];
}

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

const INPUT: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-md)",
  padding: "var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-md)",
};

export function AdminHelpContent(): React.ReactElement {
  const { session } = useAdminSession();
  const isSuperAdmin = session?.user.role === "super_admin";

  const [entries, setEntries] = useState<HelpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [locale, setLocale] = useState("en");
  const [editing, setEditing] = useState<HelpEntry | null>(null);
  const [editShort, setEditShort] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editAudience, setEditAudience] = useState<Audience>("admin");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<HelpListResponse>(`/admin/help?locale=${encodeURIComponent(locale)}`);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load help content.");
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  function startEdit(entry: HelpEntry) {
    setEditing(entry);
    setEditShort(entry.shortText);
    setEditBody(entry.longMd ?? "");
    setEditAudience(entry.audience);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      // Super admin writes the global row; a company admin writes a company override.
      const path = isSuperAdmin
        ? `/admin/help/global/${encodeURIComponent(editing.key)}`
        : `/admin/help/${encodeURIComponent(editing.key)}`;
      await adminApi(path, {
        method: "PATCH",
        body: JSON.stringify({
          audience: editAudience,
          locale: editing.locale,
          shortText: editShort,
          longMd: editBody.trim() === "" ? null : editBody,
        }),
      });
      setEditing(null);
      setToast(`Saved ${editing.key} as a new version.`);
      setTimeout(() => setToast(null), 4000);
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    try {
      const rows = await adminApi<HelpEntry[]>(`/admin/help/export?locale=${encodeURIComponent(locale)}`);
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `help-content-${locale}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Export failed.");
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data: unknown = JSON.parse(text);
      // Accept the export shape (HelpEntry[]) and map it to the import shape.
      const list = Array.isArray(data) ? (data as Partial<HelpEntry>[]) : [];
      const rows = list
        .filter((r) => typeof r.key === "string" && typeof r.shortText === "string")
        .map((r) => ({
          key: r.key as string,
          input: { audience: r.audience ?? "admin", shortText: r.shortText as string, longMd: r.longMd ?? null },
        }));
      if (rows.length === 0) {
        setError("Import file has no rows with key and shortText.");
        return;
      }
      const res = await adminApi<{ inserted: number; skipped: number }>(
        `/admin/help/import?locale=${encodeURIComponent(locale)}`,
        { method: "POST", body: JSON.stringify({ rows }) },
      );
      setToast(`Imported ${res.inserted} rows as company overrides (${res.skipped} skipped).`);
      setTimeout(() => setToast(null), 5000);
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Import failed.");
    } finally {
      e.target.value = "";
    }
  }

  const q = search.toLowerCase();
  const filtered = entries.filter(
    (e) => q === "" || e.key.toLowerCase().includes(q) || e.shortText.toLowerCase().includes(q),
  );

  return (
    <AdminShell breadcrumbs={["Settings", "Help content"]} helpPage="admin.settings.help_content">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="book">{entries.length} entries</Chip>
            </div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              Help content.
            </h1>
            <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 560, lineHeight: 1.5 }}>
              {isSuperAdmin
                ? "Edit the help text every company sees. Each save creates a new version of the global row."
                : "Edit the help text your company sees. Each save creates a company override; the platform text stays."}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
            <label className="aiq-btn aiq-btn-outline aiq-btn-sm" style={{ cursor: "pointer" }} data-help-id="admin.settings.help_content.import">
              Import JSON
              <input type="file" accept=".json" style={{ display: "none" }} onChange={(e) => void handleImport(e)} />
            </label>
            <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" onClick={() => void handleExport()}>
              Export JSON
            </button>
          </div>
        </div>

        {error && (
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{error}</div>
        )}
        {toast && <div><Chip variant="success">{toast}</Chip></div>}

        {/* Search + locale */}
        <div style={{ display: "flex", gap: "var(--aiq-space-md)", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="search"
            placeholder="Search by key or short text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...INPUT, borderRadius: "var(--aiq-radius-pill)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", minWidth: 280, maxWidth: 360 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }} data-help-id="admin.settings.help_content.locale">
            <span style={MONO_LABEL}>Locale</span>
            <input
              type="text"
              value={locale}
              onChange={(e) => setLocale(e.target.value.trim() || "en")}
              style={{ ...INPUT, width: 72, fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)" }}
              aria-label="Locale"
            />
          </label>
        </div>

        {/* Entry list */}
        {loading ? (
          <div style={{ display: "flex" }}>
            <Spinner size="sm" aria-label="Loading help content" />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }} data-help-id="admin.settings.help_content.list">
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className="aiq-card aiq-admin-detail-two-col"
                style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md) var(--aiq-space-lg)", alignItems: "start" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--aiq-space-xs)" }}>
                    <span style={MONO_LABEL}>{entry.key}</span>
                    <Chip variant={entry.tenantId === null ? "default" : "accent"}>
                      {entry.tenantId === null ? "global" : "company override"}
                    </Chip>
                    <span style={MONO_LABEL}>v{entry.version} · {entry.audience}</span>
                  </div>
                  <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                    {entry.shortText}
                  </div>
                  {entry.longMd && (
                    <p style={{ margin: "var(--aiq-space-xs) 0 0", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {entry.longMd}
                    </p>
                  )}
                </div>
                <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => startEdit(entry)}>
                  Edit
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)", padding: "var(--aiq-space-xl)", textAlign: "center" }}>
                No entries found.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editing && (
        <Modal open title={`Edit: ${editing.key}`} onClose={() => setEditing(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)" }}>
            <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }} data-help-id="admin.settings.help_content.scope">
              {isSuperAdmin
                ? `Saves a new global version (now v${editing.version}). Every company without an override sees it.`
                : "Saves a company override. Only your company sees it; the platform text is kept."}
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={MONO_LABEL}>Short text (max 120)</span>
              <input type="text" maxLength={120} value={editShort} onChange={(e) => setEditShort(e.target.value)} style={INPUT} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={MONO_LABEL}>Audience</span>
              <select value={editAudience} onChange={(e) => setEditAudience(e.target.value as Audience)} style={INPUT}>
                <option value="admin">admin</option>
                <option value="candidate">candidate</option>
                <option value="all">all</option>
              </select>
            </label>
            <label data-help-id="admin.settings.help_content.markdown" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={MONO_LABEL}>Body (Markdown — preview shown as plain text)</span>
              <textarea
                rows={8}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                style={{ ...INPUT, fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", resize: "vertical" }}
              />
            </label>
            {/* Markdown preview — PLAIN TEXT, no dangerouslySetInnerHTML */}
            <div>
              <div style={{ ...MONO_LABEL, marginBottom: "var(--aiq-space-xs)" }}>Plain text preview</div>
              <div style={{ padding: "var(--aiq-space-sm)", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)", maxHeight: 200, overflowY: "auto" }}>
                {editBody || <span style={{ color: "var(--aiq-color-fg-muted)" }}>Empty body</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", justifyContent: "flex-end" }}>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={saving || editShort.trim() === ""} onClick={() => void handleSave()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
