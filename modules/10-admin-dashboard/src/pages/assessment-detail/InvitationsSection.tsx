import React from "react";
import type { Dispatch, SetStateAction } from "react";
import { Link } from "react-router";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { CandidateCsvImport } from "../../components/CandidateCsvImport.js";
import { EmailQueuePanel } from "../../components/EmailQueuePanel.js";
import { type Invitation, INV_PAGE_SIZE, type ResendAllResponse, RESEND_SKIP_REASON, type UserItem, type SortDir } from "./shared.js";

export interface InvitationsSectionProps {
  id: string | undefined;
  resultsSort: "name" | "rank" | "branch";
  setResultsSort: Dispatch<SetStateAction<"name" | "rank" | "branch">>;
  showInviteForm: boolean;
  setShowInviteForm: Dispatch<SetStateAction<boolean>>;
  setInviteError: Dispatch<SetStateAction<string | null>>;
  setSelectedUserIds: Dispatch<SetStateAction<Set<string>>>;
  fetchData: () => Promise<void>;
  handleInvite: (e: React.FormEvent) => Promise<void>;
  uninvitedUsers: UserItem[];
  selectedUserIds: Set<string>;
  toggleUser: (userId: string) => void;
  inviteError: string | null;
  /** Z-89: test type for this batch (default = the assessment's own). */
  inviteMode: "real" | "mock";
  setInviteMode: Dispatch<SetStateAction<"real" | "mock">>;
  defaultInviteMode: "real" | "mock";
  inviting: boolean;
  resendable: number;
  resendResult: ResendAllResponse | null;
  resendError: string | null;
  setResendError: Dispatch<SetStateAction<string | null>>;
  setShowResendAll: Dispatch<SetStateAction<boolean>>;
  resendingAll: boolean;
  resendingId: string | null;
  invitations: Invitation[];
  invitationColumns: ColumnDef<Invitation>[];
  sortedInvitations: Invitation[];
  sortBy: string;
  setSortBy: Dispatch<SetStateAction<string>>;
  sortDir: SortDir;
  setSortDir: Dispatch<SetStateAction<SortDir>>;
  invPage: number;
  invPaging: boolean;
  invTotal: number;
  goToInvPage: (next: number) => Promise<void>;
}

export function InvitationsSection(props: InvitationsSectionProps): React.ReactElement {
  const {
    id, resultsSort, setResultsSort, showInviteForm, setShowInviteForm, setInviteError,
    setSelectedUserIds, fetchData, handleInvite, uninvitedUsers, selectedUserIds, toggleUser,
    inviteError, inviteMode, setInviteMode, defaultInviteMode, inviting, resendable, resendResult, resendError, setResendError,
    setShowResendAll, resendingAll, resendingId, invitations, invitationColumns,
    sortedInvitations, sortBy, setSortBy, sortDir, setSortDir, invPage, invPaging,
    invTotal, goToInvPage,
  } = props;
  return (
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
        <HelpTip helpId="admin.assessments.results_csv.sort">
          <label
            data-help-id="admin.assessments.results_csv.sort"
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
              setInviteMode(defaultInviteMode);
            }}
          >
            {showInviteForm ? "Cancel" : "+ Invite candidates"}
          </button>
        </HelpTip>
      </div>
    </div>

    {id && <CandidateCsvImport assessmentId={id} onImported={fetchData} />}

    <EmailQueuePanel refreshKey={invTotal} />

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
              All users in this organisation have already been invited.{" "}
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
              <fieldset
                data-help-id="admin.assessment.invite.test_type"
                style={{
                  border: "none",
                  padding: 0,
                  margin: "0 0 var(--aiq-space-md)",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                }}
              >
                <legend style={{ fontWeight: 600, marginBottom: "var(--aiq-space-xs)" }}>Test type</legend>
                <label style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="invite-test-type"
                    checked={inviteMode === "real"}
                    onChange={() => setInviteMode("real")}
                  />
                  Real exam (laptop or desktop only)
                </label>
                <label style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="invite-test-type"
                    checked={inviteMode === "mock"}
                    onChange={() => setInviteMode("mock")}
                  />
                  Mock test (any device, no certificate)
                </label>
              </fieldset>
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
  );
}
