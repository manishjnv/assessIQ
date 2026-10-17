// PlatformFrameworksSection: "Curriculum frameworks" on the Platform page (RW-57 part 2).
// Lists the bundled curriculum seeds and loads or reloads one into the shared catalog.
// Super admin only: platform.tsx renders this section only for that role.

import React, { useCallback, useEffect, useState } from "react";
import { Button, Chip, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminApiError } from "../../api.js";
import { listFrameworkSeedsApi, loadFrameworkSeedApi, type FrameworkSeedItem } from "../../api/frameworks.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { META_LABEL, ROW_PADDING } from "./shared.js";

const ROW_GRID = "1.4fr 90px 1.4fr 90px 1.2fr 110px";

export function PlatformFrameworksSection(): React.ReactElement {
  const [items, setItems] = useState<FrameworkSeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState<FrameworkSeedItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems((await listFrameworkSeedsApi()).items);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Could not load the curriculum list.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const confirm = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setLoadError(null);
    try {
      const r = await loadFrameworkSeedApi(pending.code);
      setToast(`Loaded ${pending.name}: ${r.nodesCreated} added, ${r.nodesUpdated} updated, ${r.nodesUnchanged} unchanged.`);
      setPending(null);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof AdminApiError ? err.apiError.message : "Load failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verb = pending?.loadedVersion === null ? "Load" : "Reload";

  return (
    <section style={{ marginTop: 48 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-2xl)",
            fontWeight: 400,
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          Curriculum frameworks.
        </h2>
        <HelpTip helpId="admin.platform.frameworks">
          <span style={{ ...META_LABEL, fontSize: "var(--aiq-text-xs)" }}>Curricula</span>
        </HelpTip>
        <Chip leftIcon="grid">{items.length} available</Chip>
      </div>
      <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 16px", maxWidth: 560, lineHeight: 1.5 }}>
        Load a board curriculum into the shared catalog. Loading again updates the same entries and adds no copies.
      </p>

      {error && <div style={{ marginBottom: 16 }}><Chip>{error}</Chip></div>}
      {toast && <div style={{ marginBottom: 16 }}><Chip variant="success">{toast}</Chip></div>}

      {loading ? (
        <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
          <Spinner aria-label="Loading curricula" />
        </div>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)" }}>No curricula are bundled with this release.</p>
      ) : (
        <div style={{ border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", overflow: "hidden", background: "var(--aiq-color-bg-base)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: ROW_GRID,
              gap: 12,
              padding: "12px 20px",
              background: "var(--aiq-color-bg-raised)",
              borderBottom: "1px solid var(--aiq-color-border)",
              ...META_LABEL,
              fontSize: "var(--aiq-text-xs)",
            }}
          >
            <span>Curriculum</span>
            <span>Board</span>
            <span>Release</span>
            <span>Entries</span>
            <span>Loaded</span>
            <span></span>
          </div>
          {items.map((it, i) => (
            <div
              key={it.code}
              style={{
                display: "grid",
                gridTemplateColumns: ROW_GRID,
                gap: 12,
                padding: ROW_PADDING,
                alignItems: "center",
                borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
              }}
            >
              <span style={{ fontSize: 14 }}>{it.name}</span>
              <span style={{ fontSize: 13 }}>{it.board}</span>
              <span style={{ fontSize: 13 }}>{it.version}</span>
              <span style={{ fontSize: 13 }}>{it.nodeCount}</span>
              <span>
                {it.loadedVersion === null ? <Chip>Not loaded</Chip> : <Chip variant="success">{it.loadedVersion || "Loaded"}</Chip>}
              </span>
              <span style={{ textAlign: "right" }}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLoadError(null);
                    setPending(it);
                  }}
                >
                  {it.loadedVersion === null ? "Load" : "Reload"}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <DangerConfirmModal
        open={pending !== null}
        title={pending ? `${verb} ${pending.name}?` : ""}
        body={
          pending ? (
            <p style={{ margin: 0 }}>
              This adds or updates {pending.nodeCount} curriculum entries in the shared catalog for every organisation. It removes nothing.
            </p>
          ) : null
        }
        confirmLabel={verb}
        busyLabel="Loading..."
        busy={busy}
        danger={false}
        error={loadError}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
