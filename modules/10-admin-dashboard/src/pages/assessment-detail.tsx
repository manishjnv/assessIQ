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
//   POST /admin/users/import                    → { csv, assessment_id } (CandidateCsvImport)
//   POST /admin/assessments/:id/publish         → draft → published
//   POST /admin/invitations/:id/resend          → new 7-day link for ONE candidate who hasn't started
//   POST /admin/assessments/:id/invitations/resend → same for everyone who hasn't started (max 200)
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
import { Chip, Modal, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { CandidateCsvImport } from "../components/CandidateCsvImport.js";
import { IntegrityCard, type IntegrityValue } from "../components/IntegrityCard.js";
import { HighStakesCard } from "../components/HighStakesCard.js";
import { RemindersCard, type RemindersValue } from "../components/RemindersCard.js";
import { adminApi, AdminApiError, getCompanyEntitlements, cancelAssessmentApi, deleteAssessmentApi } from "../api.js";
import type { TenantEntitlement } from "../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed" | "cancelled";
// Mirrors the server enum (modules/05 INVITATION_STATUSES). NOTE: 'expired' is
// what an admin REVOKE writes; a link that merely ran out of time keeps
// 'pending' / 'viewed' with an expires_at in the past (shown as "Expired").
type InvitationStatus = "pending" | "viewed" | "started" | "submitted" | "expired";

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
  settings?: { integrity?: IntegrityValue; reminders?: RemindersValue; high_stakes?: boolean } | null;
}

interface Invitation {
  id: string;
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
  status: InvitationStatus;
  created_at: string;
  expires_at: string | null;
  reminded_at?: string | null;
  attempt_id?: string | null;
  attempt_status?: string | null;
  started_at?: string | null;
  submitted_at?: string | null;
  total_earned?: number | null;
  total_max?: number | null;
  auto_pct?: number | null;
  pending_review?: boolean | null;
  /** Server-computed: Resend is allowed (assessment open + candidate not started). */
  can_resend?: boolean;
}

/** API cap for /admin/assessments/:id/invitations (routes.ts parsePagination). */
const INV_PAGE_SIZE = 100;

interface InvitationsResponse {
  items: Invitation[];
  total: number;
  /** How many invitations "Resend to everyone who hasn't started" would send (all pages). */
  resendable?: number;
}

/** POST /admin/assessments/:id/invitations/resend */
interface ResendAllResponse {
  resent: number;
  skipped: Array<{ id: string; code: string }>;
  remaining: number;
}

/** Server cap per bulk-resend call (modules/05 BULK_RESEND_MAX). */
const RESEND_ALL_CAP = 200;

/** Plain-language reasons for the skip codes the bulk resend returns. */
const RESEND_SKIP_REASON: Record<string, string> = {
  INVITATION_ALREADY_STARTED: "already started",
  USER_INACTIVE: "account disabled",
  INVITATION_EMAIL_FAILED: "email could not be sent",
  INVITATION_NOT_FOUND: "no longer exists",
  ASSESSMENT_NOT_ACTIVE: "assessment closed",
};

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

/** POST /admin/assessments/:id/release-all */
interface ReleaseAllResponse {
  released: string[];
  skipped: Array<{ id: string; code: string }>;
}

/** Plain-language reasons for the skip codes release-all returns. */
const SKIP_REASON: Record<string, string> = {
  RESULT_NOT_READY: "not ready yet",
  ATTEMPT_NOT_RELEASABLE_ERASED: "candidate data erased",
};

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
    case "started":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "submitted":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "expired":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

/** The server writes 'expired' when an admin REVOKES an invitation — say so in plain words. */
function invitationStatusLabel(s: string): string {
  return s === "expired" ? "revoked" : s;
}

/**
 * "Expires 8 Oct 2026" / "Expired" — only for links that still matter (pending
 * or viewed). Started, submitted and revoked rows have no expiry worth showing.
 */
function invitationExpiry(
  inv: Invitation,
  now: number,
): { text: string; lapsed: boolean } | null {
  if ((inv.status !== "pending" && inv.status !== "viewed") || inv.expires_at == null) {
    return null;
  }
  const at = new Date(inv.expires_at);
  if (at.getTime() <= now) return { text: "Expired", lapsed: true };
  const date = at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return { text: `Expires ${date}`, lapsed: false };
}

export function AdminAssessmentDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resultsSort, setResultsSort] = useState<"name" | "rank" | "branch">("name");
  const [error, setError] = useState<string | null>(null);

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Resend: one row ("Resend" in the Action column) or everyone who hasn't
  // started (POST /invitations/resend, confirm dialog first). Both end in the
  // same chip feedback; `resendable` is the server's count across ALL pages.
  const [resendable, setResendable] = useState(0);
  // Invitations paging: the API caps pageSize at 100, so the table shows one
  // page at a time. `invMeta` is derived from ALL pages (ids only) so the invite
  // picker and the has-attempts guard do not assume "everything is on this page".
  const [invPage, setInvPage] = useState(1);
  const [invTotal, setInvTotal] = useState(0);
  const [invPaging, setInvPaging] = useState(false);
  const [invMeta, setInvMeta] = useState<{ userIds: Set<string>; hasAttempts: boolean }>({
    userIds: new Set(),
    hasAttempts: false,
  });
  const invPageRef = React.useRef(1);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [showResendAll, setShowResendAll] = useState(false);
  const [resendingAll, setResendingAll] = useState(false);
  const [resendResult, setResendResult] = useState<ResendAllResponse | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  // "Publish all ready": publish every evaluated attempt of this assessment to
  // its candidate in one go (POST /release-all). Attempts that are not ready are
  // skipped by the server and reported back.
  const [showPublishAll, setShowPublishAll] = useState(false);
  const [publishingAll, setPublishingAll] = useState(false);
  const [publishAllResult, setPublishAllResult] = useState<ReleaseAllResponse | null>(null);
  const [publishAllError, setPublishAllError] = useState<string | null>(null);

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
          `/admin/assessments/${id}/invitations?page=${invPageRef.current}&pageSize=${INV_PAGE_SIZE}`,
        ),
        adminApi<UsersResponse>(`/admin/users?pageSize=100`),
        getCompanyEntitlements().catch(() => null),
      ]);
      setAssessment(assessmentData);
      // Deleted/revoked rows can shrink the list: clamp to the last real page.
      const lastPage = Math.max(1, Math.ceil(inviteData.total / INV_PAGE_SIZE));
      const fetchedPage = invPageRef.current;
      if (fetchedPage > lastPage) {
        invPageRef.current = lastPage;
        setInvPage(lastPage);
        const again = await adminApi<InvitationsResponse>(
          `/admin/assessments/${id}/invitations?page=${lastPage}&pageSize=${INV_PAGE_SIZE}`,
        );
        setInvitations(again.items);
      } else {
        setInvitations(inviteData.items);
      }
      setInvTotal(inviteData.total);
      setResendable(inviteData.resendable ?? 0);
      // Ids + attempt flags across ALL pages (page 1 is already in hand when it
      // is the displayed one; any further page is one extra small request).
      const userIds = new Set<string>();
      let anyAttempts = false;
      for (let p = 1; p <= lastPage; p++) {
        const res =
          p === fetchedPage
            ? inviteData
            : await adminApi<InvitationsResponse>(
                `/admin/assessments/${id}/invitations?page=${p}&pageSize=${INV_PAGE_SIZE}`,
              );
        for (const inv of res.items) {
          userIds.add(inv.user_id);
          if (inv.attempt_id != null || inv.started_at != null) anyAttempts = true;
        }
      }
      setInvMeta({ userIds, hasAttempts: anyAttempts });
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

  async function handlePublishAll() {
    if (!id) return;
    setPublishingAll(true);
    setPublishAllError(null);
    setPublishAllResult(null);
    try {
      const res = await adminApi<ReleaseAllResponse>(`/admin/assessments/${id}/release-all`, {
        method: "POST",
      });
      setPublishAllResult(res);
      await fetchData();
    } catch (err) {
      setPublishAllError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to publish results.",
      );
    } finally {
      setShowPublishAll(false);
      setPublishingAll(false);
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

  async function goToInvPage(next: number) {
    if (!id || invPaging) return;
    setInvPaging(true);
    try {
      const res = await adminApi<InvitationsResponse>(
        `/admin/assessments/${id}/invitations?page=${next}&pageSize=${INV_PAGE_SIZE}`,
      );
      invPageRef.current = next;
      setInvPage(next);
      setInvitations(res.items);
      setInvTotal(res.total);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load invitations.");
    } finally {
      setInvPaging(false);
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

  // Resend ONE invitation: new link by email, 7 days from now, old link stops
  // working. The server refuses (409) once the candidate has started.
  async function handleResendOne(inv: Invitation) {
    setResendingId(inv.id);
    setResendError(null);
    setResendResult(null);
    try {
      await adminApi(`/admin/invitations/${inv.id}/resend`, { method: "POST" });
      setResendResult({ resent: 1, skipped: [], remaining: 0 });
      await fetchData();
    } catch (err) {
      setResendError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to resend the invitation.",
      );
      // 409 (state changed, e.g. the candidate just started) / 502 (link saved,
      // email not queued): the row is different now — refresh it.
      if (err instanceof AdminApiError && (err.status === 409 || err.status === 502)) {
        await fetchData();
      }
    } finally {
      setResendingId(null);
    }
  }

  // Resend to everyone who hasn't started (server caps one call at 200; the
  // result says how many are still waiting so the admin can press it again).
  async function handleResendAll() {
    if (!id) return;
    setResendingAll(true);
    setResendError(null);
    setResendResult(null);
    try {
      const res = await adminApi<ResendAllResponse>(
        `/admin/assessments/${id}/invitations/resend`,
        { method: "POST" },
      );
      setResendResult(res);
      await fetchData();
    } catch (err) {
      setResendError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to resend invitations.",
      );
    } finally {
      setShowResendAll(false);
      setResendingAll(false);
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

  const invitedUserIds = invMeta.userIds;
  const uninvitedUsers = users.filter((u) => u.role === "candidate" && u.status === "active" && !invitedUserIds.has(u.id));

  // An assessment "has attempts" if any invitation has progressed to an attempt
  // (attempt row created or started). Hard-delete is blocked server-side when
  // attempts exist; we mirror that here to disable the Delete button + steer to
  // Cancel. The server stays authoritative (returns 422 ASSESSMENT_HAS_ATTEMPTS).
  const hasAttempts = invMeta.hasAttempts;

  // One clock reading per render so every row's "Expires … / Expired" agrees.
  const nowMs = Date.now();

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
                Reminder sent {new Date(row.reminded_at).toLocaleString()}
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
              onClick={() => void handleResendOne(row)}
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
            <Chip leftIcon="grid">{invTotal} invitation{invTotal !== 1 ? "s" : ""}</Chip>
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
            {/* Key attributes as a scannable chip row (branding §8.2). Level is
                accent-emphasised as the headline attribute; the rest are bordered
                default chips — far more legible than the prior faint fg-muted meta
                line, without tinting any background accent (branding §3.3). */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "var(--aiq-space-xs)",
              }}
            >
              {assessment.level_label != null && (
                <Chip variant="accent" leftIcon="chart">
                  Level {assessment.level_label}
                </Chip>
              )}
              {assessment.pack_name != null && (
                <Chip leftIcon="book">Pack {assessment.pack_name}</Chip>
              )}
              <Chip leftIcon="clock">
                {assessment.opens_at
                  ? `Opens ${new Date(assessment.opens_at).toLocaleDateString()}`
                  : "No open date"}
              </Chip>
              <Chip leftIcon="clock">
                {assessment.closes_at
                  ? `Closes ${new Date(assessment.closes_at).toLocaleDateString()}`
                  : "No close date"}
              </Chip>
              <Chip leftIcon="clock">
                Created {new Date(assessment.created_at).toLocaleDateString()}
              </Chip>
            </div>
          </div>
          {/* Action cluster. alignItems:flex-start keeps each button at its own
              natural height — without it the flex default (stretch) inflates the
              outline buttons to match the tall Publish+entitlement-hint column,
              and the pill radius renders the stretched buttons as ovals. All four
              buttons share the default (md) size so the cluster reads uniformly. */}
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexShrink: 0, alignItems: "flex-start" }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline"
              onClick={() => navigate("/admin/assessments")}
            >
              ← Back
            </button>
            {assessment.status !== "cancelled" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
                onClick={() => { setActionError(null); setConfirmMode("cancel"); }}
                title="Retire this assessment — keeps attempts + history, hides it from the list"
              >
                Cancel assessment
              </button>
            )}
            {assessment.status !== "cancelled" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
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

        {/* Link to attempts + bulk publish */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <div
            style={{
              padding: "var(--aiq-space-sm) var(--aiq-space-md)",
              background: "var(--aiq-color-bg-raised)",
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--aiq-space-xs)",
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
          {hasAttempts && (
            <button
              type="button"
              className="aiq-btn aiq-btn-outline"
              data-help-id="admin.assessments.release_all"
              disabled={publishingAll}
              onClick={() => { setPublishAllError(null); setShowPublishAll(true); }}
            >
              {publishingAll ? "Publishing…" : "Publish all ready"}
            </button>
          )}
        </div>

        {publishAllResult && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
            <Chip variant="success">
              Published {publishAllResult.released.length} result{publishAllResult.released.length === 1 ? "" : "s"}
            </Chip>
            {publishAllResult.skipped.length > 0 && (
              <Chip variant="warn">
                Skipped {publishAllResult.skipped.length}:{" "}
                {[...new Set(publishAllResult.skipped.map((s) => SKIP_REASON[s.code] ?? s.code))].join(", ")}
              </Chip>
            )}
          </div>
        )}

        {publishAllError && (
          <div
            role="alert"
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {publishAllError}
          </div>
        )}

        <Modal open={showPublishAll} onClose={() => setShowPublishAll(false)} title="Publish all ready results?" width={480}>
          <p
            style={{
              margin: 0,
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-secondary)",
              lineHeight: 1.6,
            }}
          >
            Every attempt of this assessment that AssessIQ has finished evaluating will be published to its
            candidate, who is emailed the result. Attempts that are not ready yet are skipped. Published
            results can't be changed.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
            <button type="button" className="aiq-btn aiq-btn-ghost" onClick={() => setShowPublishAll(false)} disabled={publishingAll}>
              Cancel
            </button>
            <button type="button" className="aiq-btn aiq-btn-primary" onClick={() => void handlePublishAll()} disabled={publishingAll}>
              {publishingAll ? "Publishing…" : "Publish all ready"}
            </button>
          </div>
        </Modal>

        <Modal
          open={showResendAll}
          onClose={() => {
            if (!resendingAll) setShowResendAll(false);
          }}
          title="Resend to everyone who hasn't started?"
          width={480}
        >
          <p
            style={{
              margin: 0,
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-secondary)",
              lineHeight: 1.6,
            }}
          >
            <strong>{Math.min(resendable, RESEND_ALL_CAP)}</strong> email
            {Math.min(resendable, RESEND_ALL_CAP) === 1 ? " will" : "s will"} be sent, one to each
            candidate who hasn't started. Each gets a new link that is valid for 7 days, and their
            old links stop working straight away.
            {resendable > RESEND_ALL_CAP
              ? ` We send ${RESEND_ALL_CAP} at a time; press the button again for the other ${
                  resendable - RESEND_ALL_CAP
                }.`
              : ""}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-ghost"
              onClick={() => setShowResendAll(false)}
              disabled={resendingAll}
            >
              Cancel
            </button>
            <button
              type="button"
              className="aiq-btn aiq-btn-primary"
              onClick={() => void handleResendAll()}
              disabled={resendingAll}
            >
              {resendingAll
                ? "Sending…"
                : `Send ${Math.min(resendable, RESEND_ALL_CAP)} email${
                    Math.min(resendable, RESEND_ALL_CAP) === 1 ? "" : "s"
                  }`}
            </button>
          </div>
        </Modal>

        <IntegrityCard key={assessment.id} assessmentId={assessment.id} initial={assessment.settings?.integrity} />
        <HighStakesCard key={`hs-${assessment.id}`} assessmentId={assessment.id} initial={assessment.settings?.high_stakes === true} />
        <RemindersCard key={`rem-${assessment.id}`} assessmentId={assessment.id} initial={assessment.settings?.reminders} />

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
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
              <HelpTip helpId="admin.assessment.results_csv.sort">
                <label
                  data-help-id="admin.assessment.results_csv.sort"
                  style={{ fontSize: "var(--aiq-text-sm)", display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}
                >
                  Sort by:
                  <select
                    value={resultsSort}
                    onChange={(e) => setResultsSort(e.target.value as "name" | "rank" | "branch")}
                    data-testid="results-sort"
                  >
                    <option value="name">Name</option>
                    <option value="rank">Rank</option>
                    <option value="branch">Branch then rank</option>
                  </select>
                </label>
              </HelpTip>
              <HelpTip helpId="admin.assessments.results.download_csv">
                <a
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  href={`/api/admin/assessments/${id}/results.csv?sort=${resultsSort}`}
                  download
                  data-help-id="admin.assessments.results.download_csv"
                >
                  Download results (CSV)
                </a>
              </HelpTip>
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
          </div>

          {id && <CandidateCsvImport assessmentId={id} onImported={fetchData} />}

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

          {/* Resend to everyone who hasn't started + the outcome chips (same style
              as the CSV-import result). The button count is the server's total
              across ALL pages; it is 0 (button hidden) once the assessment is
              closed or when every not-started link was just re-sent. */}
          {(resendable > 0 || resendResult !== null) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--aiq-space-sm)",
                flexWrap: "wrap",
                marginBottom: "var(--aiq-space-md)",
              }}
            >
              {resendable > 0 && (
                <HelpTip helpId="admin.assessments.invitations.resend_all">
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-outline aiq-btn-sm"
                    data-help-id="admin.assessments.invitations.resend_all"
                    disabled={resendingAll || resendingId !== null}
                    onClick={() => {
                      setResendError(null);
                      setShowResendAll(true);
                    }}
                  >
                    {resendingAll
                      ? "Resending…"
                      : `Resend to everyone who hasn't started (${resendable})`}
                  </button>
                </HelpTip>
              )}
              {resendResult !== null && (
                <div
                  role="status"
                  data-help-id="admin.assessments.invitations.resend_result"
                  style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}
                >
                  <Chip variant="success">{resendResult.resent} resent</Chip>
                  {resendResult.skipped.length > 0 && (
                    <Chip variant="warn">
                      {resendResult.skipped.length} skipped:{" "}
                      {[
                        ...new Set(
                          resendResult.skipped.map((s) => RESEND_SKIP_REASON[s.code] ?? s.code),
                        ),
                      ].join(", ")}
                    </Chip>
                  )}
                  {resendResult.remaining > 0 && (
                    <Chip variant="accent">
                      {resendResult.remaining} more still to send — press the button again
                    </Chip>
                  )}
                </div>
              )}
            </div>
          )}
          {resendError && (
            <div
              role="alert"
              style={{
                color: "var(--aiq-color-danger)",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                marginBottom: "var(--aiq-space-md)",
              }}
            >
              {resendError}
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

          {invTotal > INV_PAGE_SIZE && (
            <div
              data-help-id="admin.assessments.invitations.paging"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--aiq-space-sm)",
                flexWrap: "wrap",
                marginTop: "var(--aiq-space-md)",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              <span>
                Showing {(invPage - 1) * INV_PAGE_SIZE + 1}&ndash;
                {Math.min(invPage * INV_PAGE_SIZE, invTotal)} of {invTotal}
              </span>
              <span style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  disabled={invPage <= 1 || invPaging}
                  onClick={() => void goToInvPage(invPage - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  disabled={invPage * INV_PAGE_SIZE >= invTotal || invPaging}
                  onClick={() => void goToInvPage(invPage + 1)}
                >
                  Next
                </button>
              </span>
            </div>
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
