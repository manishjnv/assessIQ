// Camera feature: named reviewers (tenant settings, privacy tab). Only these admins can open camera files.
import React, { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Spinner } from "@assessiq/ui-system";
import {
  addCameraReviewerApi,
  listCameraReviewersApi,
  listTenantAdminsApi,
  removeCameraReviewerApi,
  type CameraReviewer,
} from "../api/camera.js";
import { AdminApiError } from "../api.js";

const errorText = (err: unknown): string =>
  err instanceof AdminApiError ? err.apiError.message : "Unexpected error. Try again.";

export function CameraReviewersCard(): React.ReactElement {
  const [reviewers, setReviewers] = useState<CameraReviewer[] | null>(null);
  const [admins, setAdmins] = useState<Array<{ id: string; email: string; name: string | null }>>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [rev, adm] = await Promise.all([listCameraReviewersApi(), listTenantAdminsApi()]);
      setReviewers(rev.items);
      setAdmins(adm.items);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const named = new Set((reviewers ?? []).map((r) => r.userId));
  const pickable = admins.filter((a) => !named.has(a.id));

  const add = async (): Promise<void> => {
    if (choice === "") return;
    setBusy(true);
    setError(null);
    try {
      await addCameraReviewerApi(choice);
      setChoice("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await removeCameraReviewerApi(userId);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-help-id="admin.tenant_settings.camera_reviewers">
      <Card padding="lg">
        <h3 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: 20, fontWeight: 400, margin: 0 }}>Camera reviewers.</h3>
        <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, margin: "8px 0 16px", maxWidth: 640 }}>
          Only these people can open camera files.
        </p>

        {error !== null && (
          <div role="alert" style={{ marginBottom: 12 }}>
            <Chip>{error}</Chip>
          </div>
        )}

        {reviewers === null ? (
          <Spinner aria-label="Loading camera reviewers" />
        ) : reviewers.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: 0 }}>No reviewers yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {reviewers.map((r) => (
              <li
                key={r.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "10px 0",
                  borderTop: "1px solid var(--aiq-color-border)",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 500 }}>{r.name ?? r.email}</span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>{r.email}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(r.userId)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <select
              aria-label="Admin to add as reviewer"
              value={choice}
              disabled={busy || pickable.length === 0}
              onChange={(e) => setChoice(e.target.value)}
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: 13,
                padding: "8px 10px",
                borderRadius: "var(--aiq-radius-md)",
                border: "1px solid var(--aiq-color-border-strong)",
                background: "var(--aiq-color-bg-raised)",
                color: "var(--aiq-color-fg-primary)",
                minWidth: 240,
              }}
            >
              <option value="">{pickable.length === 0 ? "No other admins" : "Choose an admin"}</option>
              {pickable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.email} ({a.email})
                </option>
              ))}
          </select>
          <Button size="sm" variant="outline" disabled={busy || choice === ""} onClick={() => void add()}>
            Add reviewer
          </Button>
        </div>
      </Card>
    </section>
  );
}
