// AssessIQ — Tenant settings page: DPDP Data Retention controls.
//
// Route: /admin/tenant-settings  (tenant admin only; route wiring done in follow-up)
//
// INVARIANT: This file must never import @anthropic-ai/sdk, @anthropic-ai/claude-agent-sdk,
// or any module that transitively imports them. AI SDK usage is restricted to
// modules/07-ai-grading/runtimes/anthropic-api.ts only.
//
// Style notes (patterned on users.tsx):
//   - Same fetch pattern: adminApi + AdminApiError
//   - Same toast/error display: Chip variant="success" / default for feedback
//   - Same meta label style (mono uppercase), same Card/Button/Field/Chip imports
//   - Same AdminShell wrapper with breadcrumbs
//
// Load-step fallback: GET /api/admin/tenant-settings is attempted first; if that
// returns 404 (endpoint not yet deployed), the page falls back to
// GET /api/admin/me which may carry retention_days in the tenant object.
// If neither provides a value, the input starts empty ("unknown — set value to
// override default") per the contract.  This is the simplest fallback: two
// sequential fetches, no extra dependencies.

import React, { useEffect, useState, type CSSProperties } from "react";
import { Button, Card, Chip, Field, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface TenantSettingsResponse {
  retention_days: number;
  updated_at: string;
}

// Shape returned by GET /api/admin/me — we only care about the retention field.
interface AdminMeResponse {
  tenant?: {
    retention_days?: number;
  };
  // other fields not used here
  [k: string]: unknown;
}

interface RetentionReport {
  tenantId: string;
  retentionDays: number;
  candidatesScanned: number;
  candidatesErased: number;
  candidatesSkipped: number;
  errors: string[];
  dryRun: boolean;
  durationMs: number;
}

// ── Shared style constants (mirrors users.tsx) ────────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export interface TenantSettingsProps {
  /**
   * When true, render the inner sections only (no AdminShell wrapper, no
   * page header). Used to embed the retention controls as a section inside
   * another settings page (e.g. /admin/settings/billing). When false
   * (default), render as the standalone /admin/tenant-settings page.
   */
  embedded?: boolean;
}

export function TenantSettings({ embedded = false }: TenantSettingsProps = {}): React.ReactElement {
  // ── Load state ────────────────────────────────────────────────────────────
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // retention_days: null means unknown (no value from any endpoint)
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Purge state ───────────────────────────────────────────────────────────
  const [previewLoading, setPreviewLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [previewReport, setPreviewReport] = useState<RetentionReport | null>(null);
  const [runReport, setRunReport] = useState<RetentionReport | null>(null);
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  // ── Load on mount ─────────────────────────────────────────────────────────

  useEffect(() => {
    void loadSettings();
  }, []);

  const loadSettings = async (): Promise<void> => {
    setLoadingSettings(true);
    setLoadError(null);
    try {
      // Primary: GET /api/admin/tenant-settings
      const data = await adminApi<TenantSettingsResponse>("/admin/tenant-settings");
      setRetentionDays(data.retention_days);
      setInputValue(String(data.retention_days));
      setUpdatedAt(data.updated_at ?? null);
    } catch (primaryErr) {
      const is404 =
        primaryErr instanceof AdminApiError && primaryErr.status === 404;

      if (is404) {
        // Fallback: GET /api/admin/me — may carry tenant.retention_days
        try {
          const me = await adminApi<AdminMeResponse>("/admin/me");
          const days = me.tenant?.retention_days;
          if (typeof days === "number") {
            setRetentionDays(days);
            setInputValue(String(days));
          }
          // If not present: leave null — input stays empty
        } catch {
          // Non-fatal: show empty input, let admin set value
        }
      } else {
        const msg =
          primaryErr instanceof AdminApiError
            ? primaryErr.apiError.message
            : "Failed to load retention settings.";
        setLoadError(msg);
      }
    } finally {
      setLoadingSettings(false);
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async (): Promise<void> => {
    const parsed = parseInt(inputValue, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 3650) {
      setSaveError("Value must be a whole number between 1 and 3650.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await adminApi("/admin/tenant-settings/retention-days", {
        method: "PATCH",
        body: JSON.stringify({ retention_days: parsed }),
      });
      setRetentionDays(parsed);
      setSaveSuccess("Retention window updated.");
      setUpdatedAt(new Date().toISOString());
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err) {
      if (err instanceof AdminApiError) {
        const code = err.apiError.details?.code as string | undefined;
        if (err.status === 403 && code === "MFA_REQUIRED") {
          setSaveError(
            "Fresh authentication required. Please re-authenticate (last MFA must be within 15 minutes) and try again.",
          );
        } else {
          setSaveError(err.apiError.message);
        }
      } else {
        setSaveError("Unexpected error — please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Purge: preview ────────────────────────────────────────────────────────

  const handlePreview = async (): Promise<void> => {
    setPreviewLoading(true);
    setPurgeError(null);
    setPreviewReport(null);
    try {
      const report = await adminApi<RetentionReport>(
        "/admin/retention/run-now?dryRun=true",
        { method: "POST" },
      );
      setPreviewReport(report);
    } catch (err) {
      const msg =
        err instanceof AdminApiError
          ? err.apiError.message
          : "Preview failed — please try again.";
      setPurgeError(msg);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Purge: run now (with confirm) ─────────────────────────────────────────

  const handleRunNow = async (): Promise<void> => {
    setShowRunConfirm(false);
    setRunLoading(true);
    setPurgeError(null);
    setRunReport(null);
    try {
      const report = await adminApi<RetentionReport>("/admin/retention/run-now", {
        method: "POST",
      });
      setRunReport(report);
    } catch (err) {
      const msg =
        err instanceof AdminApiError
          ? err.apiError.message
          : "Purge failed — please try again.";
      setPurgeError(msg);
    } finally {
      setRunLoading(false);
    }
  };

  const confirmMessage =
    previewReport !== null
      ? `This will permanently tombstone PII for ${previewReport.candidatesErased} candidate${previewReport.candidatesErased === 1 ? "" : "s"}. Continue?`
      : "Run now without preview will erase any candidates past the retention window. Continue?";

  // ── Helpers ───────────────────────────────────────────────────────────────

  const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const inputIsDirty =
    retentionDays !== null && inputValue !== String(retentionDays);
  const inputIsEmpty = inputValue.trim() === "";

  // ── Report display ────────────────────────────────────────────────────────

  function ReportTable({ report }: { report: RetentionReport }): React.ReactElement {
    return (
      <div
        style={{
          marginTop: 16,
          border: "1px solid var(--aiq-color-border)",
          borderRadius: "var(--aiq-radius-md)",
          overflow: "hidden",
          background: "var(--aiq-color-bg-base)",
        }}
      >
        {(
          [
            ["Dry-run", report.dryRun ? "Yes" : "No"],
            ["Tenant ID", report.tenantId],
            ["Retention window", `${report.retentionDays} days`],
            ["Candidates scanned", String(report.candidatesScanned)],
            ["Candidates erased", String(report.candidatesErased)],
            ["Candidates skipped", String(report.candidatesSkipped)],
            ["Duration", `${report.durationMs} ms`],
          ] as [string, string][]
        ).map(([label, value], i) => (
          <div
            key={label}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 12,
              padding: "10px 16px",
              borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
              background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
              alignItems: "start",
            }}
          >
            <span style={{ ...META_LABEL, fontSize: 10 }}>{label}</span>
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 13,
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              {value}
            </span>
          </div>
        ))}

        {report.errors.length > 0 && (
          <div
            style={{
              padding: "10px 16px",
              borderTop: "1px solid var(--aiq-color-border)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <span style={{ ...META_LABEL, fontSize: 10, display: "block", marginBottom: 6 }}>
              Errors ({report.errors.length})
            </span>
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 12,
                color: "var(--aiq-color-danger, #dc2626)",
                lineHeight: 1.6,
              }}
            >
              {report.errors.map((e, idx) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={idx}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ── Run confirm overlay ───────────────────────────────────────────────────

  function RunConfirmModal(): React.ReactElement {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.36)",
          display: "grid",
          placeItems: "center",
          zIndex: 200,
        }}
        onClick={() => setShowRunConfirm(false)}
        role="presentation"
      >
        <Card
          padding="lg"
          onClick={(e) => e.stopPropagation()}
          style={{ width: "100%", maxWidth: 480 }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
            <h2
              className="aiq-serif"
              style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
            >
              Run retention purge?
            </h2>
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowRunConfirm(false)}
              aria-label="Close"
            >
              ×
            </Button>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--aiq-color-fg-secondary)",
              margin: "0 0 24px",
              lineHeight: 1.5,
            }}
          >
            {confirmMessage}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setShowRunConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleRunNow()}>
              Run purge
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // When embedded, render only the inner DPDP sections (no AdminShell, no
  // page-header chip/title — the parent page owns those). When standalone,
  // wrap with AdminShell + render the page header. Both paths share the
  // same retention + purge JSX below.
  const inner = (
    <>
      {showRunConfirm && <RunConfirmModal />}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {!embedded && (
          /* Page header */
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="settings">Tenant settings</Chip>
            </div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              Settings.
            </h1>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 0",
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Tenant-level configuration for data retention and compliance controls.
            </p>
          </div>
        )}

        {/* ── DPDP Data Retention section ─────────────────────────────────── */}
        <section aria-labelledby="dpdp-retention-heading">
          <div
            style={{
              paddingBottom: 16,
              borderBottom: "1px solid var(--aiq-color-border)",
              marginBottom: 24,
            }}
          >
            <h2
              id="dpdp-retention-heading"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: 22,
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              DPDP Data Retention.
            </h2>
          </div>

          {/* ── Retention window control ─────────────────────────────────── */}
          <Card padding="lg" style={{ marginBottom: 24 }}>

            {loadingSettings ? (
              <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
                <Spinner aria-label="Loading retention settings" />
              </div>
            ) : (
              <>
                {loadError && (
                  <div style={{ marginBottom: 16 }}>
                    <Chip>{loadError}</Chip>
                  </div>
                )}

                <div style={{ maxWidth: 400 }}>
                  {/* Label row */}
                  <label
                    htmlFor="retention-days-input"
                    style={{
                      display: "block",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                      marginBottom: 6,
                    }}
                  >
                    Candidate PII retention window (days)
                  </label>

                  {/* Number input — styled to match Field primitives */}
                  <input
                    id="retention-days-input"
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={inputValue}
                    placeholder="unknown — set value to override default"
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      setSaveError(null);
                      setSaveSuccess(null);
                    }}
                    disabled={saving}
                    style={{
                      display: "block",
                      width: "100%",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "10px 12px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border-strong)",
                      background: "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      boxSizing: "border-box",
                    }}
                  />

                  <p
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: "var(--aiq-color-fg-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    Candidates whose last activity is older than this are PII-tombstoned by
                    the nightly retention cron. Default 730 (2 years HR-grade). Range 1–3650.
                  </p>

                  {updatedAt && !inputIsDirty && (
                    <p style={{ ...META_LABEL, fontSize: 10, marginTop: 6 }}>
                      Last updated · {formatDate(updatedAt)}
                    </p>
                  )}
                </div>

                {/* Feedback */}
                {saveSuccess && (
                  <div style={{ marginTop: 16 }}>
                    <Chip variant="success">{saveSuccess}</Chip>
                  </div>
                )}
                {saveError && (
                  <div
                    role="alert"
                    style={{
                      marginTop: 16,
                      fontSize: 13,
                      color: "var(--aiq-color-danger, #dc2626)",
                      lineHeight: 1.4,
                    }}
                  >
                    {saveError}
                  </div>
                )}

                <div style={{ marginTop: 20 }}>
                  <Button
                    onClick={() => void handleSave()}
                    loading={saving}
                    disabled={inputIsEmpty}
                  >
                    Save retention window
                  </Button>
                </div>
              </>
            )}
          </Card>

          {/* ── Retention purge panel ────────────────────────────────────── */}
          <Card padding="lg">
            <div style={{ marginBottom: 16 }}>
              <h3
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: 18,
                  fontWeight: 400,
                  margin: "0 0 6px",
                  letterSpacing: "-0.01em",
                }}
              >
                Run retention purge.
              </h3>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--aiq-color-fg-secondary)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Manually trigger the retention cron outside its nightly schedule.
                Run a dry-run preview first to see how many candidates are affected
                before committing.
              </p>
            </div>

            {purgeError && (
              <div style={{ marginBottom: 16 }}>
                <Chip>{purgeError}</Chip>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                variant="outline"
                onClick={() => void handlePreview()}
                loading={previewLoading}
                disabled={runLoading}
              >
                Preview (dry-run)
              </Button>
              <Button
                onClick={() => setShowRunConfirm(true)}
                loading={runLoading}
                disabled={previewLoading}
              >
                Run now
              </Button>
            </div>

            {/* Preview report */}
            {previewReport !== null && (
              <div style={{ marginTop: 20 }}>
                <div style={{ marginBottom: 8 }}>
                  <Chip variant="accent">Dry-run result</Chip>
                </div>
                <ReportTable report={previewReport} />
              </div>
            )}

            {/* Live-run report */}
            {runReport !== null && (
              <div style={{ marginTop: 20 }}>
                <div style={{ marginBottom: 8 }}>
                  <Chip variant="success">Purge complete</Chip>
                </div>
                <ReportTable report={runReport} />
              </div>
            )}
          </Card>
        </section>

      </div>
    </>
  );

  if (embedded) {
    return inner;
  }
  return (
    <AdminShell breadcrumbs={["Settings"]} helpPage="admin.tenant-settings">
      {inner}
    </AdminShell>
  );
}
