import React from "react";
import type { Dispatch, SetStateAction } from "react";
import { Link } from "react-router-dom";
import { Chip, Modal } from "@assessiq/ui-system";
import { type Assessment, type ReleaseAllResponse, RESEND_ALL_CAP, SKIP_REASON } from "./shared.js";

export interface ReleaseResendBlockProps {
  assessment: Assessment;
  hasAttempts: boolean;
  publishingAll: boolean;
  setPublishAllError: Dispatch<SetStateAction<string | null>>;
  setShowPublishAll: Dispatch<SetStateAction<boolean>>;
  publishAllResult: ReleaseAllResponse | null;
  publishAllError: string | null;
  showPublishAll: boolean;
  handlePublishAll: () => Promise<void>;
  showResendAll: boolean;
  setShowResendAll: Dispatch<SetStateAction<boolean>>;
  resendingAll: boolean;
  resendable: number;
  handleResendAll: () => Promise<void>;
}

export function ReleaseResendBlock(props: ReleaseResendBlockProps): React.ReactElement {
  const {
    assessment, hasAttempts, publishingAll, setPublishAllError, setShowPublishAll,
    publishAllResult, publishAllError, showPublishAll, handlePublishAll, showResendAll,
    setShowResendAll, resendingAll, resendable, handleResendAll,
  } = props;
  return (
    <>
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
        {publishingAll ? "Releasing…" : "Release all ready"}
      </button>
    )}
  </div>

  {publishAllResult && (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
      <Chip variant="success">
        Released {publishAllResult.released.length} result{publishAllResult.released.length === 1 ? "" : "s"}
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

  <Modal open={showPublishAll} onClose={() => setShowPublishAll(false)} title="Release all ready results?" width={480}>
    <p
      style={{
        margin: 0,
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        color: "var(--aiq-color-fg-secondary)",
        lineHeight: 1.6,
      }}
    >
      Every attempt of this assessment that AssessIQ has finished grading will be released to its
      candidate, who is emailed the result. Attempts that are not ready yet are skipped. Released
      results can't be changed.
    </p>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
      <button type="button" className="aiq-btn aiq-btn-ghost" onClick={() => setShowPublishAll(false)} disabled={publishingAll}>
        Cancel
      </button>
      <button type="button" className="aiq-btn aiq-btn-primary" onClick={() => void handlePublishAll()} disabled={publishingAll}>
        {publishingAll ? "Releasing…" : "Release all ready"}
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
      old links stop working straight away. Candidates who received a resend in the last 24
      hours are skipped.
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
    </>
  );
}
