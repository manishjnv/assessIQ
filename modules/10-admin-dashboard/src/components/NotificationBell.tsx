// AssessIQ — admin top-bar notification bell (FU-B16).
//
// Live backend: GET /admin/notifications?limit=N -> { items, cursor } (no `unread`
// filter exists, so unread = read_at == null, filtered here) and
// POST /admin/notifications/:id/mark-read. Polls every 60s and refetches on open.
// Uses the ui-system "bell" icon (lucide-react is not a dependency of this package).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, formatRelative } from "@assessiq/ui-system";
import { adminApi } from "../api.js";

interface Note { id: string; message: string; link: string | null; read_at: string | null; created_at: string }

export function NotificationBell(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    adminApi<{ items: Note[] }>("/admin/notifications?limit=50")
      .then((r) => setItems(r.items.filter((n) => n.read_at === null)))
      .catch(() => { /* bell is non-critical; stay silent */ });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    load();
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, load]);

  function read(n: Note) {
    setItems((cur) => cur.filter((x) => x.id !== n.id));
    void adminApi(`/admin/notifications/${n.id}/mark-read`, { method: "POST" }).catch(() => load());
    if (n.link) { setOpen(false); navigate(n.link); }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        data-help-id="admin.notifications.bell"
        aria-label={items.length > 0 ? `Notifications, ${items.length} unread` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ position: "relative", background: "none", border: "none", cursor: "pointer", padding: 4, display: "inline-flex" }}
      >
        <Icon name="bell" size={20} />
        {items.length > 0 && (
          <span style={{ position: "absolute", top: -2, right: -4, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999, background: "var(--aiq-color-danger)", color: "white", fontSize: 10, lineHeight: "16px", textAlign: "center", fontFamily: "var(--aiq-font-mono)" }}>
            {items.length > 9 ? "9+" : items.length}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 340, background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 50, padding: "var(--aiq-space-sm)" }}>
          {items.length === 0 && <div style={{ padding: 12, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>You are all caught up.</div>}
          {items.slice(0, 5).map((n) => (
            <button key={n.id} type="button" role="menuitem" onClick={() => read(n)} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "8px 12px", borderRadius: 8 }}>
              <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, color: "var(--aiq-color-fg-muted)" }}>{formatRelative(n.created_at)}</div>
              <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>{n.message}</div>
            </button>
          ))}
          {/* ponytail: no notifications page exists yet, so no "View all" link; shows a count instead. */}
          {items.length > 5 && <div style={{ padding: "6px 12px", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>+{items.length - 5} more unread</div>}
        </div>
      )}
    </div>
  );
}
