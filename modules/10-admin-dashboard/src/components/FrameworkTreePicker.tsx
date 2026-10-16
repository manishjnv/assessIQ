// RW-61: shared curriculum framework tree picker (WAI-ARIA tree).
// Loads all nodes of a framework in one call (parent-first) and builds the tree
// client-side; a node's children render only after the node is expanded.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Spinner } from "@assessiq/ui-system";
import {
  listFrameworksApi,
  listFrameworkNodesApi,
  type FrameworkItem,
  type FrameworkNode,
  type FrameworkNodeKind,
} from "../api/frameworks.js";

export interface FrameworkTreePickerProps {
  /** When absent, a framework select is shown. */
  frameworkId?: string;
  value: string[];
  /** `lookup` holds every node loaded so far (for parent labels). */
  onChange: (ids: string[], nodes: FrameworkNode[], lookup: ReadonlyMap<string, FrameworkNode>) => void;
  multiple?: boolean;
  readOnly?: boolean;
  /** Only these node kinds can be selected; other nodes stay visible for navigation. */
  kinds?: FrameworkNodeKind[];
  helpId: string;
}

const muted: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-muted)",
};

export function FrameworkTreePicker(props: FrameworkTreePickerProps): React.ReactElement {
  const { frameworkId, value, onChange, multiple = false, readOnly = false, kinds, helpId } = props;
  const [frameworks, setFrameworks] = useState<FrameworkItem[]>([]);
  const [fwId, setFwId] = useState<string>(frameworkId ?? "");
  const [nodes, setNodes] = useState<FrameworkNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Nodes seen so far, so onChange can return node objects even after a framework switch.
  const known = useRef<Map<string, FrameworkNode>>(new Map());

  useEffect(() => {
    if (frameworkId) { setFwId(frameworkId); return; }
    let live = true;
    listFrameworksApi()
      .then((r) => {
        if (!live) return;
        setFrameworks(r.items);
        setFwId((cur) => cur || r.items[0]?.id || "");
      })
      .catch(() => { if (live) setError("Could not load frameworks."); });
    return () => { live = false; };
  }, [frameworkId]);

  useEffect(() => {
    if (!fwId) { setNodes([]); return; }
    let live = true;
    setLoading(true);
    setError(null);
    listFrameworkNodesApi(fwId)
      .then((r) => {
        if (!live) return;
        r.items.forEach((n) => known.current.set(n.id, n));
        setNodes(r.items);
        setExpanded(new Set());
      })
      .catch(() => { if (live) setError("Could not load framework nodes."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [fwId]);

  const { childrenOf, byId } = useMemo(() => {
    const c = new Map<string | null, FrameworkNode[]>();
    const b = new Map<string, FrameworkNode>();
    for (const n of nodes) {
      b.set(n.id, n);
      const arr = c.get(n.parent_id) ?? [];
      arr.push(n);
      c.set(n.parent_id, arr);
    }
    return { childrenOf: c, byId: b };
  }, [nodes]);

  const q = query.trim().toLowerCase();
  // Search: matches plus all their ancestors are visible; ancestors auto-expand.
  const { visible, autoOpen } = useMemo(() => {
    if (!q) return { visible: null as Set<string> | null, autoOpen: new Set<string>() };
    const vis = new Set<string>();
    const open = new Set<string>();
    for (const n of nodes) {
      if (!(n.label.toLowerCase().includes(q) || (n.code ?? "").toLowerCase().includes(q))) continue;
      vis.add(n.id);
      let p = n.parent_id;
      while (p && !open.has(p)) {
        open.add(p);
        vis.add(p);
        p = byId.get(p)?.parent_id ?? null;
      }
    }
    return { visible: vis, autoOpen: open };
  }, [q, nodes, byId]);

  const selected = new Set(value);
  const canSelect = (n: FrameworkNode) => !kinds || kinds.includes(n.kind);

  function toggleSelect(n: FrameworkNode) {
    if (readOnly || !canSelect(n)) return;
    const next = multiple
      ? (selected.has(n.id) ? value.filter((v) => v !== n.id) : [...value, n.id])
      : (selected.has(n.id) ? [] : [n.id]);
    onChange(next, next.map((id) => known.current.get(id)).filter((x): x is FrameworkNode => !!x), known.current);
  }

  function toggleOpen(id: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  function renderLevel(parent: string | null, depth: number): React.ReactNode {
    const kids = (childrenOf.get(parent) ?? []).filter((n) => !visible || visible.has(n.id));
    if (kids.length === 0) return null;
    return (
      <ul
        role={depth === 0 ? "tree" : "group"}
        aria-label={depth === 0 ? "Framework nodes" : undefined}
        style={{ listStyle: "none", margin: 0, paddingLeft: depth === 0 ? 0 : "var(--aiq-space-md)" }}
      >
        {kids.map((n) => {
          const hasKids = (childrenOf.get(n.id)?.length ?? 0) > 0;
          const open = hasKids && (expanded.has(n.id) || autoOpen.has(n.id));
          const checkable = canSelect(n);
          return (
            <li
              key={n.id}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasKids ? open : undefined}
              aria-selected={checkable ? selected.has(n.id) : undefined}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (hasKids) toggleOpen(n.id); else toggleSelect(n);
                }
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", padding: "2px 0" }}>
                {hasKids ? (
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                    aria-label={`${open ? "Collapse" : "Expand"} ${n.label}`}
                    onClick={() => toggleOpen(n.id)}
                  >
                    <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined }}>
                      <Icon name="arrow" size={12} />
                    </span>
                  </button>
                ) : (
                  <span style={{ width: 28, flexShrink: 0 }} aria-hidden="true" />
                )}
                {checkable ? (
                  <label
                    style={{
                      ...muted,
                      color: "var(--aiq-color-fg-primary)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--aiq-space-xs)",
                      cursor: readOnly ? "default" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(n.id)}
                      disabled={readOnly}
                      onChange={() => toggleSelect(n)}
                      style={{ accentColor: "var(--aiq-color-accent)" }}
                    />
                    {n.label}
                    {n.code && (
                      <span style={{ ...muted, fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>{n.code}</span>
                    )}
                  </label>
                ) : (
                  <span style={{ ...muted, color: "var(--aiq-color-fg-primary)" }}>
                    {n.label}
                    {n.code && (
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", marginLeft: 6 }}>{n.code}</span>
                    )}
                  </span>
                )}
              </div>
              {open && renderLevel(n.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div data-help-id={helpId} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
      <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
        {!frameworkId && frameworks.length > 0 && (
          <select className="aiq-input" aria-label="Framework" value={fwId} onChange={(e) => setFwId(e.target.value)} style={{ maxWidth: 280 }}>
            {frameworks.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <input
          className="aiq-input"
          type="search"
          aria-label="Search framework nodes"
          placeholder="Search by name or code"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      </div>
      {error && <div role="alert" style={{ ...muted, color: "var(--aiq-color-danger)" }}>{error}</div>}
      {loading ? (
        <Spinner size="sm" />
      ) : (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {nodes.length === 0 && !error && fwId ? <span style={muted}>This framework has no nodes.</span> : renderLevel(null, 0)}
          {q && nodes.length > 0 && visible && visible.size === 0 && <span style={muted}>No nodes match your search.</span>}
        </div>
      )}
    </div>
  );
}
