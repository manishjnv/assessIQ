// AssessIQ — Admin Assessment Detail page.
//
// /admin/assessments/:id
//
// Shows: assessment metadata header, invitations list with status,
// "+ Invite candidates" inline form (checkbox multi-select from users list),
// link to /admin/attempts filtered by this assessment.
//
// Fetches:
//   GET /admin/assessments/:id                  → assessment metadata
//   GET /admin/assessments/:id/invitations      → invitation list
//   GET /admin/users?pageSize=100               → user list for invite picker
//   GET /api/billing/entitlements               → B2: entitled pack/domain list (fail-open)
//   POST /admin/assessments/:id/invite          → { user_ids: string[] }
//   POST /admin/assessments/:id/publish         → draft → published
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.
//
// B2 — Entitlement filter (FE convenience; server is authoritative):
//   getCompanyEntitlements() is fetched on mount. If it fails (billing service
//   down, network error), we fail-OPEN — show the Publish button as normal; the
//   server enforces the entitlement check on POST /publish. We never hard-block
//   the publish action client-side.
//   The entitlement hint is shown near the Publish button on draft assessments
//   to inform the admin whether the current pack appears entitled. The check is:
//     pack_id ∈ active pack-scope entitlements
//     OR (domain field available on pack object) domain ∈ active domain-scope.
//   Since the FE Assessment object carries only pack_id (no domain), we filter
//   by pack_id scope only and show the note regardless — over-showing is safe.

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { adminApi, AdminApiError, getCompanyEntitlements, cancelAssessmentApi, deleteAssessmentApi } from "../api.js";
import type { TenantEntitlement } from "../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed" | "cancelled";
type InvitationStatus = "pending" | "accepted" | "expired" | "submitted";

interface Assessment {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  level_label?: string | null;
  pack_name?: string | null;
}

interface Invitation {
  id: string;
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
  status: InvitationStatus;
  created_at: string;
  expires_at: string | null;
  attempt_id?: string | null;
  attempt_status?: string | null;
  started_at?: string | null;
  submitted_at?: string | null;
  total_earned?: number | null;
  total_max?: number | null;
  auto_pct?: number | null;
  pending_review?: boolean | null;
}

interface InvitationsResponse {
  items: Invitation[];
  total: number;
}

interface UserItem {
  id: string;
  email: string;
  name?: string;
  role?: string;
  status?: string;
}

interface UsersResponse {
  items: UserItem[];
}

type SortDir = "asc" | "desc";

/** Client-side row sort. Keys ending in `_at` sort as dates; numeric columns
 *  numerically; everything else case-insensitively. */
function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (key.endsWith("_at")) {
      const at = av ? new Date(av as string).getTime() : 0;
      const bt = bv ? new Date(bv as string).getTime() : 0;
      return sign * (at - bt);
    }
    if (typeof av === "number" && typeof bv === "number") return sign * (av - bv);
    const as = String(av ?? "").toLowerCase();
    const bs = String(bv ?? "").toLowerCase();
    return as < bs ? -1 * sign : as > bs ? 1 * sign : 0;
  });
}

function assessmentStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "active":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "published":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "closed":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

function invitationStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "accepted":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "submitted":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "expired":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

export function AdminAssessmentDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Delete / Cancel confirm-modal state. confirmMode drives the single shared
  // DangerConfirmModal: "delete" = hard delete (zero-attempts), "cancel" = soft
  // retire (→ cancelled). Both outcomes remove the row from the default list,
  // so a success navigates back to the list.
  const [confirmMode, setConfirmMode] = useState<null | "delete" | "cancel">(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [sortBy, setSortBy] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // B2 — entitlement hint state (FE convenience; server is authoritative).
  // null = not yet loaded; [] = loaded but empty; populated = entitlements fetched.
  // Fetch failure → stays null → fail-open (Publish button shown normally).
  const [entitlements, setEntitlements] = useState<TenantEntitlement[] | null>(null);

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch assessment, invitations, user list, and entitlements in parallel.
      // Users: cap at 100 (api-contract pageSize cap for /admin/users).
      // Entitlements: fail-open — if the fetch errors, we keep entitlements=null
      // and show the note unconditionally (server still enforces on publish).
      const [assessmentData, inviteData, usersData, entitlementsResult] = await Promise.all([
        adminApi<Assessment>(`/admin/assessments/${id}`),
        adminApi<InvitationsResponse>(
          `/admin/assessments/${id}/invitations?pageSize=100`,
        ),
        adminApi<UsersResponse>(`/admin/users?pageSize=100`),
        getCompanyEntitlements().catch(() => null),
      ]);
      setAssessment(assessmentData);
      setInvitations(inviteData.items);
      setUsers(usersData.items);
      setEntitlements(entitlementsResult?.entitlements ?? null);
    } catch (err) {
      setError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to load assessment.",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function handlePublish() {
    if (!id) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await adminApi(`/admin/assessments/${id}/publish`, { method: "POST" });
      await fetchData();
    } catch (err) {
      setPublishError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to publish.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function handleConfirmAction() {
    if (!id || confirmMode === null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (confirmMode === "delete") {
        await deleteAssessmentApi(id);
      } else {
        await cancelAssessmentApi(id);
      }
      // Deleted rows are gone; cancelled rows drop out of the default list.
      // Either way, return to the list rather than re-render a stale detail.
      navigate("/admin/assessments");
    } catch (err) {
      setActionError(
        err instanceof AdminApiError ? err.apiError.message : "Action failed. Please try again.",
      );
      setActionBusy(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!id || selectedUserIds.size === 0) {
      setInviteError("Select at least one candidate.");
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await adminApi(`/admin/assessments/${id}/invite`, {
        method: "POST",
        body: JSON.stringify({ user_ids: Array.from(selectedUserIds) }),
      });
      setSelectedUserIds(new Set());
      setShowInviteForm(false);
      await fetchData();
    } catch (err) {
      setInviteError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to send invitations.",
      );
    } finally {
      setInviting(false);
    }
  }

  function toggleUser(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const invitedUserIds = new Set(invitations.map((inv) => inv.user_id));
  const uninvitedUsers = users.filter((u) => u.role === "candidate" && u.status === "active" && !invitedUserIds.has(u.id));

  // An assessment "has attempts" if any invitation has progressed to an attempt
  // (attempt row created or started). Hard-delete is blocked server-side when
  // attempts exist; we mirror that here to disable the Delete button + steer to
  // Cancel. The server stays authoritative (returns 422 ASSESSMENT_HAS_ATTEMPTS).
  const hasAttempts = invitations.some(
    (inv) => inv.attempt_id != null || inv.started_at != null,
  );

  const invitationColumns: ColumnDef<Invitation>[] = [
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
        return (
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
            {row.status}
          </span>
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
          {new Date(row.created_at).toLocaleDateString()}
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
          {row.started_at != null ? new Date(row.started_at).toLocaleDateString() : "—"}
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
          {row.submitted_at != null ? new Date(row.submitted_at).toLocaleDateString() : "—"}
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
        if (row.attempt_id == null) return <span>—</span>;
        return (
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
        );
      },
    },
  ];

  // MUST be computed before the early returns below — a hook after a conditional
  // return changes the hook order between the loading and loaded renders, which
  // crashes React ("rendered more hooks than during the previous render") and
  // blanks the page. (Regression from the sortable-tables change.)
  const sortedInvitations = React.useMemo(
    () => (sortBy ? sortRows(invitations, sortBy, sortDir) : invitations),
    [invitations, sortBy, sortDir],
  );

  if (loading) {
    return (
      <AdminShell breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, "Detail"]} helpPage="admin.assessments">
        <div
          style={{
            color: "var(--aiq-color-fg-muted)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            padding: "var(--aiq-space-xl) 0",
          }}
        >
          Loading…
        </div>
      </AdminShell>
    );
  }

  if (error || !assessment) {
    return (
      <AdminShell breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, "Detail"]} helpPage="admin.assessments">
        <div
          style={{
            color: "var(--aiq-color-danger)",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {error ?? "Assessment not found."}
        </div>
      </AdminShell>
    );
  }

  const sc = assessmentStatusColor(assessment.status);

  return (
    <AdminShell
      breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, assessment.name]}
      helpPage="admin.assessments"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{invitations.length} invitation{invitations.length !== 1 ? "s" : ""}</Chip>
          </div>
          <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--aiq-space-md)",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--aiq-space-sm)",
                marginBottom: "var(--aiq-space-xs)",
              }}
            >
              <h1
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-3xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.02em",
                }}
              >
                {assessment.name}.
              </h1>
              <span
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "1px 8px",
                  borderRadius: "var(--aiq-radius-pill)",
                  background: sc.bg,
                  color: sc.color,
                  flexShrink: 0,
                }}
              >
                {assessment.status}
              </span>
              {assessment.level_label != null && (
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "1px 8px",
                    borderRadius: "var(--aiq-radius-pill)",
                    background: "var(--aiq-color-bg-sunken)",
                    color: "var(--aiq-color-fg-muted)",
                    flexShrink: 0,
                  }}
                >
                  LEVEL {assessment.level_label}
                </span>
              )}
            </div>
            <p
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {assessment.opens_at
                ? `Opens ${new Date(assessment.opens_at).toLocaleDateString()}`
                : "No open date"}{" "}
              ·{" "}
              {assessment.closes_at
                ? `Closes ${new Date(assessment.closes_at).toLocaleDateString()}`
                : "No close date"}{" "}
              · Created {new Date(assessment.created_at).toLocaleDateString()}
              {assessment.pack_name != null && (
                <>{" · Pack "}{assessment.pack_name}</>
              )}
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexShrink: 0 }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={() => navigate("/admin/assessments")}
            >
              ← Back
            </button>
            {assessment.status !== "cancelled" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                onClick={() => { setActionError(null); setConfirmMode("cancel"); }}
                title="Retire this assessment — keeps attempts + history, hides it from the list"
              >
                Cancel assessment
              </button>
            )}
            {assessment.status !== "cancelled" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                style={hasAttempts ? undefined : { color: "var(--aiq-color-danger)", borderColor: "var(--aiq-color-danger)" }}
                disabled={hasAttempts}
                onClick={() => { setActionError(null); setConfirmMode("delete"); }}
                title={hasAttempts
                  ? "This assessment has candidate attempts — cancel it instead of deleting"
                  : "Permanently delete this assessment"}
              >
                Delete
              </button>
            )}
            {assessment.status === "draft" && (
              <div data-help-id="admin.assessments.content_source" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--aiq-space-xs)" }}>
                <HelpTip helpId="admin.assessments.publish">
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary"
                    onClick={() => void handlePublish()}
                    disabled={publishing}
                  >
                    {publishing ? "Publishing…" : "Publish"}
                  </button>
                </HelpTip>
                {/* B2 — entitlement hint (FE convenience; server enforces).
                    Shown when pack_id is set. If entitlements loaded and the
                    pack_id is NOT in active pack-scope entitlements, show a
                    warning. If entitlements failed to load (null), show the
                    general note — server will enforce on submit. */}
                {assessment.pack_id !== null && (() => {
                  const packEntitled =
                    entitlements !== null &&
                    entitlements.some(
                      (e) => e.scope_type === 'pack' && e.scope_id === assessment.pack_id,
                    );
                  const showWarning = entitlements !== null && !packEntitled;
                  return (
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-xs)",
                        color: showWarning
                          ? "var(--aiq-color-danger)"
                          : "var(--aiq-color-fg-muted)",
                        textAlign: "right",
                        maxWidth: 260,
                        lineHeight: 1.4,
                      }}
                    >
                      {showWarning
                        ? "This pack may not be entitled for your plan — publishing will fail if not. Contact your platform operator to enable it."
                        : "Only content your plan is entitled to is shown. Contact your platform operator to enable more."}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
        </div>

        {publishError && (
          <div
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {publishError}
          </div>
        )}

        {/* Link to attempts */}
        <div
          style={{
            padding: "var(--aiq-space-sm) var(--aiq-space-md)",
            background: "var(--aiq-color-bg-raised)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--aiq-space-xs)",
            alignSelf: "flex-start",
          }}
        >
          <Link
            to={`/admin/attempts?assessmentId=${assessment.id}`}
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-accent)",
              textDecoration: "none",
            }}
          >
            View attempts for this assessment →
          </Link>
        </div>

        {/* Invitations section */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            <h2
              data-help-id="admin.assessments.invite.bulk"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.015em",
              }}
            >
              Invitations.
            </h2>
            <HelpTip helpId="admin.assessments.invite.bulk">
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                onClick={() => {
                  setShowInviteForm((v) => !v);
                  setInviteError(null);
                  setSelectedUserIds(new Set());
                }}
              >
                {showInviteForm ? "Cancel" : "+ Invite candidates"}
              </button>
            </HelpTip>
          </div>

          {/* Invite inline form */}
          {showInviteForm && (
            <div
              style={{
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
                padding: "var(--aiq-space-md)",
                marginBottom: "var(--aiq-space-md)",
                background: "var(--aiq-color-bg-raised)",
              }}
            >
              <form onSubmit={(e) => void handleInvite(e)}>
                {uninvitedUsers.length === 0 ? (
                  <p
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      color: "var(--aiq-color-fg-muted)",
                      margin: "0 0 var(--aiq-space-md)",
                    }}
                  >
                    All users in this tenant have already been invited.{" "}
                    <Link
                      to="/admin/users"
                      style={{
                        color: "var(--aiq-color-accent)",
                        textDecoration: "none",
                      }}
                    >
                      Add more users →
                    </Link>
                  </p>
                ) : (
                  <>
                    <p
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-sm)",
                        color: "var(--aiq-color-fg-secondary)",
                        margin: "0 0 var(--aiq-space-sm)",
                      }}
                    >
                      Select candidates to invite. Users already invited are not shown.
                    </p>
                    <div
                      style={{
                        maxHeight: 240,
                        overflowY: "auto",
                        border: "1px solid var(--aiq-color-border)",
                        borderRadius: "var(--aiq-radius-sm)",
                        marginBottom: "var(--aiq-space-md)",
                      }}
                    >
                      {uninvitedUsers.map((u) => (
                        <label
                          key={u.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--aiq-space-sm)",
                            padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                            cursor: "pointer",
                            borderBottom: "1px solid var(--aiq-color-border)",
                            background: selectedUserIds.has(u.id)
                              ? "var(--aiq-color-accent-soft)"
                              : "transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedUserIds.has(u.id)}
                            onChange={() => toggleUser(u.id)}
                          />
                          <span
                            style={{
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-sm)",
                            }}
                          >
                            {u.email}
                          </span>
                          {u.name && (
                            <span
                              style={{
                                fontFamily: "var(--aiq-font-sans)",
                                fontSize: "var(--aiq-text-xs)",
                                color: "var(--aiq-color-fg-muted)",
                              }}
                            >
                              ({u.name})
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                    {inviteError && (
                      <div
                        style={{
                          color: "var(--aiq-color-danger)",
                          fontFamily: "var(--aiq-font-sans)",
                          fontSize: "var(--aiq-text-sm)",
                          marginBottom: "var(--aiq-space-sm)",
                        }}
                      >
                        {inviteError}
                      </div>
                    )}
                    <button
                      type="submit"
                      className="aiq-btn aiq-btn-primary"
                      disabled={inviting || selectedUserIds.size === 0}
                    >
                      {inviting
                        ? "Sending…"
                        : `Invite ${selectedUserIds.size > 0 ? selectedUserIds.size + " " : ""}candidate${
                            selectedUserIds.size !== 1 ? "s" : ""
                          }`}
                    </button>
                  </>
                )}
              </form>
            </div>
          )}

          {invitations.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "var(--aiq-space-2xl) 0",
                color: "var(--aiq-color-fg-muted)",
                border: "1px dashed var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  margin: 0,
                }}
              >
                No candidates invited yet.
              </p>
            </div>
          ) : (
            <Table columns={invitationColumns} data={sortedInvitations} {...(sortBy ? { sortBy } : {})} sortDir={sortDir} onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }} />
          )}
        </div>
      </div>

      <DangerConfirmModal
        open={confirmMode !== null}
        title={confirmMode === "delete" ? "Delete this assessment?" : "Cancel this assessment?"}
        body={
          confirmMode === "delete" ? (
            <>
              Permanently delete <strong>{assessment.name}</strong>. Its invitations and
              frozen question set are removed with it. This cannot be undone.
            </>
          ) : (
            <>
              Retire <strong>{assessment.name}</strong> — it moves to <em>cancelled</em> and
              drops out of the list. Attempts and history are kept. It can&rsquo;t be un-cancelled.
            </>
          )
        }
        confirmLabel={confirmMode === "delete" ? "Delete permanently" : "Cancel assessment"}
        busyLabel={confirmMode === "delete" ? "Deleting…" : "Cancelling…"}
        busy={actionBusy}
        error={actionError}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => {
          if (!actionBusy) {
            setConfirmMode(null);
            setActionError(null);
          }
        }}
      />
    </AdminShell>
  );
}
