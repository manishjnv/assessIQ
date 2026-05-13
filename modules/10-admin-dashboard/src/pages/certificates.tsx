// AssessIQ — Admin Certificates management page.
//
// /admin/certificates
//
// Lists all certificates issued to candidates in the tenant. Allows admins
// to revoke active certificates (with a reason) and reissue (replace) them.
//
// Fetches:
//   GET  /api/admin/certificates                            → { items, total }
//   POST /api/admin/certificates/:credentialId/revoke       → 204
//   POST /api/admin/certificates/:credentialId/reissue      → 204
//
// INVARIANTS:
//  - Filter state is client-side React state; no URL params, no localStorage.
//  - Modals are inline JSX — no separate files.
//  - Toast auto-dismisses after 3 s via setTimeout.
//  - super_admin users see an extra tenant_id column (truncated).
//  - No new npm dependencies — mirrors generation-attempts.tsx in all patterns.

import React, { useEffect, useState, useCallback } from "react";
import { Chip, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";
import { useAdminSession } from "../session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CertTier = "completion" | "distinction" | "honors";
type CertStatus = "active" | "revoked";

interface CertAdminRow {
  id: string;
  credential_id: string;
  candidate_id: string;
  user_email: string | null;
  tier: CertTier;
  course_title: string;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  tenant_id?: string;
}

interface CertListResponse {
  items: CertAdminRow[];
  total: number;
}

// ---------------------------------------------------------------------------
// Tier / status styling (mirrors STATUS_COLORS from generation-attempts.tsx)
// ---------------------------------------------------------------------------

const TIER_STYLES: Record<CertTier, { bg: string; fg: string; label: string }> = {
  completion: { bg: "var(--aiq-color-accent-soft)", fg: "var(--aiq-color-accent)",   label: "Completion" },
  distinction: { bg: "#fef3c7",                      fg: "#d97706",                   label: "Distinction" },
  honors:      { bg: "var(--aiq-color-success-soft)", fg: "var(--aiq-color-success)", label: "Honors"     },
};

const STATUS_STYLES: Record<CertStatus, { bg: string; fg: string; label: string }> = {
  active:  { bg: "var(--aiq-color-success-soft)", fg: "var(--aiq-color-success)", label: "Active"  },
  revoked: { bg: "#fee2e2",                        fg: "var(--aiq-color-danger)",  label: "Revoked" },
};

function TierPill({ tier }: { tier: CertTier }): React.ReactElement {
  const { bg, fg, label } = TIER_STYLES[tier] ?? TIER_STYLES.completion;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: "var(--aiq-radius-full, 9999px)",
        background: bg,
        color: fg,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: CertStatus }): React.ReactElement {
  const { bg, fg, label } = STATUS_STYLES[status] ?? STATUS_STYLES.active;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: "var(--aiq-radius-full, 9999px)",
        background: bg,
        color: fg,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

function formatDate(isoStr: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(isoStr));
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AdminCertificates(): React.ReactElement {
  const { session } = useAdminSession();
  const isSuperAdmin = session?.user.role === "super_admin";

  // List state
  const [items, setItems]     = useState<CertAdminRow[]>([]);
  const [total, setTotal]     = useState(0);
  const [offset, setOffset]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Filter state
  const [tierFilter, setTierFilter]     = useState<CertTier | "all">("all");
  const [statusFilter, setStatusFilter] = useState<CertStatus | "all">("all");

  // Revoke modal state
  const [revokeModalId, setRevokeModalId]   = useState<string | null>(null); // credential_id
  const [revokeReason, setRevokeReason]     = useState("");
  const [revokeLoading, setRevokeLoading]   = useState(false);
  const [revokeError, setRevokeError]       = useState<string | null>(null);

  // Reissue modal state
  const [reissueModalId, setReissueModalId]         = useState<string | null>(null); // credential_id
  const [reissueDisplayName, setReissueDisplayName] = useState("");
  const [reissueLoading, setReissueLoading]         = useState(false);
  const [reissueError, setReissueError]             = useState<string | null>(null);

  // Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const LIMIT = 50;

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  const fetchCerts = useCallback(async (currentOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(LIMIT));
      params.set("offset", String(currentOffset));
      if (tierFilter !== "all") params.set("tier", tierFilter);
      if (statusFilter !== "all") params.set("revoked", statusFilter === "revoked" ? "true" : "false");

      const data = await adminApi<CertListResponse>(
        `/admin/certificates?${params.toString()}`,
      );
      if (currentOffset === 0) {
        setItems(data.items);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setTotal(data.total);
      setOffset(currentOffset);
    } catch (e) {
      const msg = e instanceof AdminApiError ? e.message : "Failed to load certificates";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [tierFilter, statusFilter]);

  // Reset and re-fetch when filters change
  useEffect(() => {
    setOffset(0);
    setItems([]);
    void fetchCerts(0);
  }, [fetchCerts]);

  function handleLoadMore() {
    const nextOffset = offset + LIMIT;
    void fetchCerts(nextOffset);
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleRevoke = useCallback(async () => {
    if (!revokeModalId || !revokeReason.trim()) return;
    setRevokeLoading(true);
    setRevokeError(null);
    try {
      await adminApi(`/admin/certificates/${revokeModalId}/revoke`, {
        method: "POST",
        body: JSON.stringify({ revoke_reason: revokeReason.trim() }),
      });
      setRevokeModalId(null);
      setRevokeReason("");
      setToastMessage("Certificate revoked successfully.");
      setTimeout(() => setToastMessage(null), 3000);
      // Re-fetch from top
      setOffset(0);
      setItems([]);
      void fetchCerts(0);
    } catch (e) {
      setRevokeError(e instanceof AdminApiError ? e.message : "Revoke failed");
    } finally {
      setRevokeLoading(false);
    }
  }, [revokeModalId, revokeReason, fetchCerts]);

  const handleReissue = useCallback(async () => {
    if (!reissueModalId) return;
    setReissueLoading(true);
    setReissueError(null);
    try {
      await adminApi(`/admin/certificates/${reissueModalId}/reissue`, {
        method: "POST",
        body: JSON.stringify({ display_name: reissueDisplayName || undefined }),
      });
      setReissueModalId(null);
      setReissueDisplayName("");
      setToastMessage("Certificate reissued successfully.");
      setTimeout(() => setToastMessage(null), 3000);
      // Re-fetch from top
      setOffset(0);
      setItems([]);
      void fetchCerts(0);
    } catch (e) {
      setReissueError(e instanceof AdminApiError ? e.message : "Reissue failed");
    } finally {
      setReissueLoading(false);
    }
  }, [reissueModalId, reissueDisplayName, fetchCerts]);

  // ---------------------------------------------------------------------------
  // Chip helper (mirrors generation-attempts.tsx exactly)
  // ---------------------------------------------------------------------------

  const chipStyle = (active: boolean, fg?: string): React.CSSProperties => ({
    display: "inline-block",
    padding: "3px 12px",
    borderRadius: "var(--aiq-radius-full, 9999px)",
    border: `1px solid ${active ? (fg ?? "var(--aiq-color-accent)") : "var(--aiq-color-border)"}`,
    background: active ? (fg ? `${fg}18` : "var(--aiq-color-accent-soft)") : "transparent",
    color: active ? (fg ?? "var(--aiq-color-accent)") : "var(--aiq-color-fg-muted)",
    fontFamily: "var(--aiq-font-mono)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    userSelect: "none",
    transition: "border-color 0.12s, background 0.12s",
  });

  // ---------------------------------------------------------------------------
  // Shared modal / button styles (kept inline to avoid extra files)
  // ---------------------------------------------------------------------------

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 900,
  };

  const modalCardStyle: React.CSSProperties = {
    background: "var(--aiq-color-bg-base)",
    borderRadius: "var(--aiq-radius-md)",
    padding: "var(--aiq-space-lg) var(--aiq-space-xl)",
    minWidth: "360px",
    maxWidth: "480px",
    width: "100%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    fontFamily: "var(--aiq-font-sans)",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: 600,
    color: "var(--aiq-color-fg-muted)",
    marginBottom: "var(--aiq-space-xs)",
  };

  const inputBaseStyle: React.CSSProperties = {
    width: "100%",
    padding: "var(--aiq-space-sm) var(--aiq-space-md)",
    border: "1px solid var(--aiq-color-border)",
    borderRadius: "var(--aiq-radius-sm)",
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-sm)",
    background: "var(--aiq-color-bg-raised)",
    color: "var(--aiq-color-fg-primary)",
    boxSizing: "border-box",
  };

  const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-sm)",
    fontWeight: 600,
    padding: "6px 18px",
    borderRadius: "var(--aiq-radius-sm)",
    background: disabled ? "var(--aiq-color-bg-raised)" : "var(--aiq-color-accent)",
    color: disabled ? "var(--aiq-color-fg-muted)" : "#fff",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.7 : 1,
  });

  const secondaryBtnStyle: React.CSSProperties = {
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-sm)",
    fontWeight: 400,
    padding: "6px 18px",
    borderRadius: "var(--aiq-radius-sm)",
    background: "transparent",
    color: "var(--aiq-color-fg-secondary)",
    border: "1px solid var(--aiq-color-border)",
    cursor: "pointer",
  };

  const errorBannerStyle: React.CSSProperties = {
    marginBottom: "var(--aiq-space-md)",
    padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
    background: "#fee2e2",
    border: "1px solid var(--aiq-color-danger)",
    borderRadius: "var(--aiq-radius-sm)",
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-xs)",
    color: "var(--aiq-color-danger)",
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasMore  = items.length < total;
  const colCount = isSuperAdmin ? 9 : 8;

  return (
    <AdminShell breadcrumbs={["Certificates"]} helpPage="admin.certificates.list">
      {/* ── Page header ── */}
      <div style={{ padding: "var(--aiq-space-lg) var(--aiq-space-xl) var(--aiq-space-md)" }}>
        <div style={{ marginBottom: 12 }}>
          <Chip leftIcon="grid">{total} certificate{total !== 1 ? "s" : ""}</Chip>
        </div>
        <h1
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-3xl)",
            fontWeight: 400,
            letterSpacing: "-0.02em",
            margin: "0 0 var(--aiq-space-xs)",
          }}
        >
          Certificates.
        </h1>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
          Credentials issued to candidates in this tenant.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div
        style={{
          padding: "0 var(--aiq-space-xl) var(--aiq-space-md)",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--aiq-space-md)",
          alignItems: "center",
          borderBottom: "1px solid var(--aiq-color-border)",
        }}
      >
        {/* Tier chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 4 }}>
            Tier:
          </span>
          {(["all", "completion", "distinction", "honors"] as const).map((t) => {
            const color = t === "all" ? undefined : TIER_STYLES[t as CertTier]?.fg;
            return (
              <button
                key={t}
                type="button"
                style={chipStyle(tierFilter === t, color)}
                onClick={() => setTierFilter(t)}
              >
                {t === "all" ? "All" : TIER_STYLES[t as CertTier].label}
              </button>
            );
          })}
        </div>

        {/* Status chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 4 }}>
            Status:
          </span>
          {(["all", "active", "revoked"] as const).map((s) => {
            const color = s === "all" ? undefined : STATUS_STYLES[s as CertStatus]?.fg;
            return (
              <button
                key={s}
                type="button"
                style={chipStyle(statusFilter === s, color)}
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All" : STATUS_STYLES[s as CertStatus].label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ padding: "0 var(--aiq-space-xl)", overflowX: "auto" }}>
        {error && (
          <div
            style={{
              margin: "var(--aiq-space-md) 0",
              padding: "var(--aiq-space-sm) var(--aiq-space-md)",
              background: "#fee2e2",
              border: "1px solid var(--aiq-color-danger)",
              borderRadius: "var(--aiq-radius-sm)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {!error && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--aiq-color-border)", textAlign: "left" }}>
                {[
                  "Credential ID",
                  "Email",
                  "Tier",
                  "Course",
                  "Issued",
                  "Status",
                  "Revoke reason",
                  ...(isSuperAdmin ? ["Tenant"] : []),
                  "Actions",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-xs)",
                      fontWeight: 600,
                      color: "var(--aiq-color-fg-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr>
                  <td colSpan={colCount} style={{ padding: "var(--aiq-space-xl)", textAlign: "center" }}>
                    <Spinner aria-label="Loading certificates" />
                  </td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={colCount} style={{ padding: "var(--aiq-space-xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)" }}>
                    No certificates found.
                  </td>
                </tr>
              )}
              {items.map((cert) => {
                const isRevoked       = cert.revoked_at !== null;
                const status: CertStatus = isRevoked ? "revoked" : "active";

                return (
                  <tr
                    key={cert.id}
                    style={{
                      borderBottom: "1px solid var(--aiq-color-border)",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Credential ID */}
                    <td
                      title={cert.credential_id}
                      style={{
                        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: "var(--aiq-text-xs)",
                        color: "var(--aiq-color-fg-secondary)",
                        maxWidth: "160px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cert.credential_id}
                    </td>

                    {/* Email */}
                    <td
                      style={{
                        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: "var(--aiq-text-xs)",
                        color: "var(--aiq-color-fg-secondary)",
                        maxWidth: "200px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cert.user_email ?? "—"}
                    </td>

                    {/* Tier */}
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", whiteSpace: "nowrap" }}>
                      <TierPill tier={cert.tier} />
                    </td>

                    {/* Course title */}
                    <td
                      title={cert.course_title}
                      style={{
                        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                        color: "var(--aiq-color-fg-primary)",
                        maxWidth: "220px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cert.course_title}
                    </td>

                    {/* Issued at */}
                    <td
                      style={{
                        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: "var(--aiq-text-xs)",
                        color: "var(--aiq-color-fg-secondary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDate(cert.issued_at)}
                    </td>

                    {/* Status */}
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", whiteSpace: "nowrap" }}>
                      <StatusPill status={status} />
                    </td>

                    {/* Revoke reason */}
                    <td
                      title={cert.revoke_reason ?? undefined}
                      style={{
                        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-xs)",
                        color: "var(--aiq-color-fg-muted)",
                        maxWidth: "200px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cert.revoke_reason ?? "—"}
                    </td>

                    {/* Tenant ID — super_admin only */}
                    {isSuperAdmin && (
                      <td
                        title={cert.tenant_id}
                        style={{
                          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-fg-muted)",
                          maxWidth: "120px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {cert.tenant_id ? `${cert.tenant_id.slice(0, 8)}…` : "—"}
                      </td>
                    )}

                    {/* Actions */}
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", whiteSpace: "nowrap" }}>
                      {!isRevoked && (
                        <button
                          type="button"
                          onClick={() => {
                            setRevokeModalId(cert.credential_id);
                            setRevokeReason("");
                            setRevokeError(null);
                          }}
                          style={{
                            fontFamily: "var(--aiq-font-sans)",
                            fontSize: "var(--aiq-text-xs)",
                            color: "var(--aiq-color-danger)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "2px 6px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Revoke
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setReissueModalId(cert.credential_id);
                          setReissueDisplayName("");
                          setReissueError(null);
                        }}
                        style={{
                          fontFamily: "var(--aiq-font-sans)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-accent)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: "2px 6px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Reissue
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── Pagination ── */}
        {!error && (
          <div
            style={{
              padding: "var(--aiq-space-md) 0 var(--aiq-space-xl)",
              display: "flex",
              alignItems: "center",
              gap: "var(--aiq-space-md)",
            }}
          >
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
              Showing {items.length} of {total}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loading}
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  padding: "4px 16px",
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-sm)",
                  background: "var(--aiq-color-bg-raised)",
                  color: "var(--aiq-color-fg-primary)",
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Revoke modal ── */}
      {revokeModalId && (
        <div style={overlayStyle}>
          <div style={modalCardStyle}>
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-sm)",
              }}
            >
              Revoke Certificate
            </h2>
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-secondary)",
                margin: "0 0 var(--aiq-space-md)",
              }}
            >
              Credential:{" "}
              <code style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>
                {revokeModalId}
              </code>
            </p>
            <div style={{ marginBottom: "var(--aiq-space-md)" }}>
              <label htmlFor="revoke-reason" style={labelStyle}>
                Reason (required)
              </label>
              <textarea
                id="revoke-reason"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                minLength={1}
                maxLength={500}
                rows={4}
                placeholder="Describe why this certificate is being revoked…"
                style={{
                  ...inputBaseStyle,
                  resize: "vertical",
                  minHeight: "80px",
                }}
              />
              <div
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "10px",
                  color: "var(--aiq-color-fg-muted)",
                  textAlign: "right",
                  marginTop: "2px",
                }}
              >
                {revokeReason.length}/500
              </div>
            </div>
            {revokeError && <div style={errorBannerStyle}>{revokeError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
              <button
                type="button"
                style={secondaryBtnStyle}
                onClick={() => {
                  setRevokeModalId(null);
                  setRevokeReason("");
                  setRevokeError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                style={primaryBtnStyle(revokeLoading || !revokeReason.trim())}
                disabled={revokeLoading || !revokeReason.trim()}
                onClick={() => { void handleRevoke(); }}
              >
                {revokeLoading ? "Revoking…" : "Revoke certificate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reissue modal ── */}
      {reissueModalId && (
        <div style={overlayStyle}>
          <div style={modalCardStyle}>
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-sm)",
              }}
            >
              Reissue Certificate
            </h2>
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-secondary)",
                margin: "0 0 var(--aiq-space-md)",
              }}
            >
              Credential:{" "}
              <code style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>
                {reissueModalId}
              </code>
            </p>
            <div style={{ marginBottom: "var(--aiq-space-md)" }}>
              <label htmlFor="reissue-display-name" style={labelStyle}>
                Display name (optional — leave blank to keep current)
              </label>
              <input
                id="reissue-display-name"
                type="text"
                value={reissueDisplayName}
                onChange={(e) => setReissueDisplayName(e.target.value)}
                placeholder="e.g. Jane Smith"
                style={inputBaseStyle}
              />
            </div>
            {reissueError && <div style={errorBannerStyle}>{reissueError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
              <button
                type="button"
                style={secondaryBtnStyle}
                onClick={() => {
                  setReissueModalId(null);
                  setReissueDisplayName("");
                  setReissueError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                style={primaryBtnStyle(reissueLoading)}
                disabled={reissueLoading}
                onClick={() => { void handleReissue(); }}
              >
                {reissueLoading ? "Reissuing…" : "Reissue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "var(--aiq-space-lg)",
            right: "var(--aiq-space-lg)",
            background: "var(--aiq-color-success)",
            color: "#fff",
            padding: "var(--aiq-space-sm) var(--aiq-space-md)",
            borderRadius: "var(--aiq-radius-sm)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            zIndex: 1000,
            boxShadow: "0 4px 16px rgba(0,0,0,0.16)",
          }}
        >
          {toastMessage}
        </div>
      )}
    </AdminShell>
  );
}
