// AssessIQ — Admin help content management page.
//
// /admin/settings/help-content
//
// P2.D14: Admin can view, edit, and import/export help text entries.
// Consumes:
//   GET  /api/admin/help-content   → list all help entries for tenant
//   PUT  /api/admin/help-content/:id → update a single entry
//   POST /api/admin/help-content/import → JSON upload
//   GET  /api/admin/help-content/export → download JSON
//
// Markdown preview shown as plain text (no renderer — avoids XSS risk).
// Full Markdown rendering is deferred to Phase 3.
//
// INVARIANTS:
//  - help_id is immutable (platform-defined). Admin edits title + body only.
//  - No dangerouslySetInnerHTML.

import React, { useEffect, useState, useCallback } from "react";
import { Modal } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

interface HelpEntry {
  id: string;
  help_id: string;
  title: string;
  body: string;
  locale: string;
  updated_at: string;
}

interface HelpListResponse {
  entries: HelpEntry[];
}

export function AdminHelpContent(): React.ReactElement {
  const [entries, setEntries] = useState<HelpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<HelpEntry | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<HelpListResponse>("/admin/help-content");
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load help content.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startEdit(entry: HelpEntry) {
    setEditing(entry);
    setEditTitle(entry.title);
    setEditBody(entry.body);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    try {
      await adminApi(`/admin/help-content/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: editTitle, body: editBody }),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    try {
      const blob = await adminApi<Blob>("/admin/help-content/export");
      const url = URL.createObjectURL(blob as unknown as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `help-content-${new Date().toISOString().slice(0, 10)}.json`;
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
      await adminApi("/admin/help-content/import", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Import failed.");
    }
  }

  const filtered = entries.filter(
    (e) =>
      search === "" ||
      e.help_id.toLowerCase().includes(search.toLowerCase()) ||
      e.title.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <AdminShell breadcrumbs={["Settings", "Help content"]} helpPage="admin.settings.help_content">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Help content.
          </h1>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
            <label className="aiq-btn aiq-btn-outline aiq-btn-sm" style={{ cursor: "pointer" }}>
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

        {/* Search */}
        <input
          type="search"
          placeholder="Search by help_id or title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-md)",
            padding: "var(--aiq-space-sm) var(--aiq-space-md)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-pill)",
            maxWidth: 360,
          }}
        />

        {/* Entry list */}
        {loading ? (
          <div style={{ color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>Loading…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className="aiq-card"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "var(--aiq-space-md)",
                  padding: "var(--aiq-space-md) var(--aiq-space-lg)",
                  alignItems: "start",
                }}
              >
                <div>
                  <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: "var(--aiq-space-xs)" }}>
                    {entry.help_id}
                  </div>
                  <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                    {entry.title}
                  </div>
                  <p style={{ margin: "var(--aiq-space-xs) 0 0", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {entry.body}
                  </p>
                </div>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  onClick={() => startEdit(entry)}
                >
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
        <Modal
          open
          title={`Edit: ${editing.help_id}`}
          onClose={() => setEditing(null)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>Title</span>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                Body (Markdown — preview shown as plain text)
              </span>
              <textarea
                rows={8}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", resize: "vertical" }}
              />
            </label>
            {/* Markdown preview — PLAIN TEXT, no dangerouslySetInnerHTML */}
            <div>
              <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: "var(--aiq-space-xs)" }}>
                Plain text preview
              </div>
              <div style={{ padding: "var(--aiq-space-sm)", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)", maxHeight: 200, overflowY: "auto" }}>
                {editBody || <span style={{ color: "var(--aiq-color-fg-muted)" }}>Empty body</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", justifyContent: "flex-end" }}>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
