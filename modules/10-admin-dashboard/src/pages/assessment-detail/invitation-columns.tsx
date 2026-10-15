import React from "react";
import { Link } from "react-router-dom";
import { formatDate, formatDateTime } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { invitationExpiry, invitationStatusColor, invitationStatusLabel, type Invitation } from "./shared.js";

export interface InvitationColumnsDeps {
  nowMs: number;
  resendingId: string | null;
  resendingAll: boolean;
  onResend: (inv: Invitation) => void | Promise<void>;
}

export function buildInvitationColumns({ nowMs, resendingId, resendingAll, onResend }: InvitationColumnsDeps): ColumnDef<Invitation>[] {
  return [
    {
      key: "user_name",
      label: "Candidate",
      sortable: true,
      render: (row: Invitation) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}
          >
            {row.user_name ?? row.user_email ?? row.user_id}
          </span>
          {row.user_email != null && (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              {row.user_email}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (row: Invitation) => {
        const c = invitationStatusColor(row.status);
        const expiry = invitationExpiry(row, nowMs);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "1px 8px",
                borderRadius: "var(--aiq-radius-pill)",
                background: c.bg,
                color: c.color,
              }}
            >
              {invitationStatusLabel(row.status)}
            </span>
            {expiry !== null && (
              <span
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  color: expiry.lapsed ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)",
                }}
              >
                {expiry.text}
              </span>
            )}
            {row.reminded_at != null && (row.status === "pending" || row.status === "viewed") && (
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                Reminder sent {formatDateTime(row.reminded_at)}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "created_at",
      label: "Invited",
      sortable: true,
      render: (row: Invitation) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: "started_at",
      label: "Started",
      sortable: true,
      render: (row: Invitation) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.started_at != null ? formatDate(row.started_at) : "—"}
        </span>
      ),
    },
    {
      key: "submitted_at",
      label: "Submitted",
      sortable: true,
      render: (row: Invitation) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.submitted_at != null ? formatDate(row.submitted_at) : "—"}
        </span>
      ),
    },
    {
      key: "auto_pct",
      label: "Score",
      sortable: true,
      render: (row: Invitation) => {
        if (row.auto_pct == null) {
          return (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              —
            </span>
          );
        }
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  fontWeight: 500,
                }}
              >
                {Math.round(row.auto_pct)}%
              </span>
              {row.pending_review === true && (
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "1px 6px",
                    borderRadius: "var(--aiq-radius-pill)",
                    background: "var(--aiq-color-bg-sunken)",
                    color: "var(--aiq-color-fg-muted)",
                  }}
                >
                  review pending
                </span>
              )}
            </div>
            {row.total_earned != null && row.total_max != null && (
              <span
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  color: "var(--aiq-color-fg-muted)",
                }}
              >
                {row.total_earned} / {row.total_max}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "attempt_id",
      label: "Action",
      sortable: false,
      render: (row: Invitation) => {
        // Resend is offered only while the candidate has not started (the
        // server decides: can_resend). A started row shows "View attempt →".
        const resendBtn =
          row.can_resend === true ? (
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              data-help-id="admin.assessments.invitations.resend"
              title="Email a new link, valid for 7 days. The old link stops working."
              aria-label={`Resend invitation to ${row.user_email ?? row.user_name ?? "this candidate"}`}
              disabled={resendingId !== null || resendingAll}
              onClick={() => void onResend(row)}
            >
              {resendingId === row.id ? "Sending…" : "Resend"}
            </button>
          ) : null;
        const viewLink =
          row.attempt_id != null ? (
            <Link
              to={`/admin/attempts/${row.attempt_id}`}
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-accent)",
                textDecoration: "none",
              }}
            >
              View attempt →
            </Link>
          ) : null;
        if (resendBtn === null && viewLink === null) return <span>—</span>;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
            {resendBtn}
            {viewLink}
          </div>
        );
      },
    },
  ];
}
