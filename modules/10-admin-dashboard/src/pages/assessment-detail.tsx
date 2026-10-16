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

import { assessmentStatusDisplay } from "../lib/labels.js";
import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chip, formatDate } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { IntegrityCard } from "../components/IntegrityCard.js";
import { SectionsCard } from "../components/SectionsCard.js";
import { HighStakesCard } from "../components/HighStakesCard.js";
import { RemindersCard } from "../components/RemindersCard.js";
import { buildInvitationColumns } from "./assessment-detail/invitation-columns.js";
import { ReleaseResendBlock } from "./assessment-detail/ReleaseResendBlock.js";
import { InvitationsSection } from "./assessment-detail/InvitationsSection.js";
import { adminApi, AdminApiError, getCompanyEntitlements, cancelAssessmentApi, deleteAssessmentApi } from "../api.js";
import type { TenantEntitlement } from "../api.js";
import { type Assessment, type Invitation, INV_PAGE_SIZE, type InvitationsResponse, type ResendAllResponse, type UserItem, type UsersResponse, type ReleaseAllResponse, type SortDir, sortRows, assessmentStatusVariant } from "./assessment-detail/shared.js";

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
        err instanceof AdminApiError ? err.apiError.message : "Failed to release results.",
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

  const invitationColumns: ColumnDef<Invitation>[] = buildInvitationColumns({ nowMs, resendingId, resendingAll, onResend: handleResendOne });

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
              <Chip variant={assessmentStatusVariant(assessment.status)}>
                {assessmentStatusDisplay(assessment.status).label}
              </Chip>
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
                  Difficulty {assessment.level_label}
                </Chip>
              )}
              {assessment.pack_name != null && (
                <Chip leftIcon="book">Question set {assessment.pack_name}</Chip>
              )}
              <Chip leftIcon="clock">
                {assessment.opens_at
                  ? `Opens ${formatDate(assessment.opens_at)}`
                  : "No open date"}
              </Chip>
              <Chip leftIcon="clock">
                {assessment.closes_at
                  ? `Closes ${formatDate(assessment.closes_at)}`
                  : "No close date"}
              </Chip>
              <Chip leftIcon="clock">
                Created {formatDate(assessment.created_at)}
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
              <div data-help-id="admin.assessments.list.content_source" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--aiq-space-xs)" }}>
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
                        ? "This question set may not be entitled for your plan — publishing will fail if not. Contact your platform operator to enable it."
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
        <ReleaseResendBlock
          assessment={assessment}
          hasAttempts={hasAttempts}
          publishingAll={publishingAll}
          setPublishAllError={setPublishAllError}
          setShowPublishAll={setShowPublishAll}
          publishAllResult={publishAllResult}
          publishAllError={publishAllError}
          showPublishAll={showPublishAll}
          handlePublishAll={handlePublishAll}
          showResendAll={showResendAll}
          setShowResendAll={setShowResendAll}
          resendingAll={resendingAll}
          resendable={resendable}
          handleResendAll={handleResendAll}
        />

        <IntegrityCard key={assessment.id} assessmentId={assessment.id} initial={assessment.settings?.integrity} />
        <SectionsCard
          key={`sec-${assessment.id}`}
          assessmentId={assessment.id}
          settings={assessment.settings as Record<string, unknown> | null | undefined}
          hasAttempts={hasAttempts}
          isDraft={assessment.status === "draft"}
          onSaved={(settings, qc) =>
            setAssessment({
              ...assessment,
              settings: settings as NonNullable<Assessment["settings"]>,
              ...(qc !== null ? { question_count: qc } : {}),
            })
          }
        />
        {/* help_id: admin.assessments.advanced */}
        <details>
          <summary
            style={{
              cursor: "pointer",
              color: "var(--aiq-color-fg-muted)",
              fontSize: "var(--aiq-text-sm)",
              userSelect: "none",
              padding: "var(--aiq-space-xs) 0",
            }}
          >
            Advanced settings
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", marginTop: "var(--aiq-space-sm)" }}>
            <HighStakesCard key={`hs-${assessment.id}`} assessmentId={assessment.id} initial={assessment.settings?.high_stakes === true} />
            <RemindersCard key={`rem-${assessment.id}`} assessmentId={assessment.id} initial={assessment.settings?.reminders} />
          </div>
        </details>

        {/* Invitations section */}
        <InvitationsSection
          id={id}
          resultsSort={resultsSort}
          setResultsSort={setResultsSort}
          showInviteForm={showInviteForm}
          setShowInviteForm={setShowInviteForm}
          setInviteError={setInviteError}
          setSelectedUserIds={setSelectedUserIds}
          fetchData={fetchData}
          handleInvite={handleInvite}
          uninvitedUsers={uninvitedUsers}
          selectedUserIds={selectedUserIds}
          toggleUser={toggleUser}
          inviteError={inviteError}
          inviting={inviting}
          resendable={resendable}
          resendResult={resendResult}
          resendError={resendError}
          setResendError={setResendError}
          setShowResendAll={setShowResendAll}
          resendingAll={resendingAll}
          resendingId={resendingId}
          invitations={invitations}
          invitationColumns={invitationColumns}
          sortedInvitations={sortedInvitations}
          sortBy={sortBy}
          setSortBy={setSortBy}
          sortDir={sortDir}
          setSortDir={setSortDir}
          invPage={invPage}
          invPaging={invPaging}
          invTotal={invTotal}
          goToInvPage={goToInvPage}
        />
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
