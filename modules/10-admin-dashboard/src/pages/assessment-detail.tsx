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
//   POST /admin/assessments/:id/invite          → { user_ids: string[] }
//   POST /admin/assessments/:id/publish         → draft → published
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed";
type InvitationStatus = "pending" | "accepted" | "expired" | "submitted";

interface Assessment {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
}

interface Invitation {
  id: string;
  user_id: string;
  user_email?: string;
  user_name?: string;
  status: InvitationStatus;
  created_at: string;
  expires_at: string | null;
}

interface InvitationsResponse {
  items: Invitation[];
  total: number;
}

interface UserItem {
  id: string;
  email: string;
  name?: string;
}

interface UsersResponse {
  items: UserItem[];
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

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch assessment, invitations, and user list in parallel.
      // Users: cap at 100 (api-contract pageSize cap for /admin/users).
      const [assessmentData, inviteData, usersData] = await Promise.all([
        adminApi<Assessment>(`/admin/assessments/${id}`),
        adminApi<InvitationsResponse>(
          `/admin/assessments/${id}/invitations?pageSize=100`,
        ),
        adminApi<UsersResponse>(`/admin/users?pageSize=100`),
      ]);
      setAssessment(assessmentData);
      setInvitations(inviteData.items);
      setUsers(usersData.items);
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
  const uninvitedUsers = users.filter((u) => !invitedUserIds.has(u.id));

  const invitationColumns: ColumnDef<Invitation>[] = [
    {
      key: "user_email",
      label: "Candidate",
      render: (row: Invitation) => (
        <span
          style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}
        >
          {row.user_email ?? row.user_id}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
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
      key: "expires_at",
      label: "Expires",
      render: (row: Invitation) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.expires_at ? new Date(row.expires_at).toLocaleDateString() : "—"}
        </span>
      ),
    },
  ];

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Assessments", "Detail"]} helpPage="admin.assessments.detail">
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
      <AdminShell breadcrumbs={["Assessments", "Detail"]} helpPage="admin.assessments.detail">
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
      breadcrumbs={["Assessments", assessment.name]}
      helpPage="admin.assessments.detail"
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
            {assessment.status === "draft" && (
              <button
                type="button"
                data-help-id="admin.assessments.publish"
                className="aiq-btn aiq-btn-primary"
                onClick={() => void handlePublish()}
                disabled={publishing}
              >
                {publishing ? "Publishing…" : "Publish"}
              </button>
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
            <Table columns={invitationColumns} data={invitations} />
          )}
        </div>
      </div>
    </AdminShell>
  );
}
