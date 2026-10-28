// EXP-12 wave 1: "Affected attempts" panel for one question.
// Lists attempts that used an older version of the question and lets an admin mark each one as reviewed by hand.
// Nothing here changes a mark, status, certificate or report. Notes are free text for tenant admins only.

import React, { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminApiError } from "../api.js";
import { getAffectedAttemptsApi, putAffectedAttemptReviewApi } from "../api/review.js";
import type { AffectedAttemptItem, AffectedAttemptsResponse, AffectedReviewOutcome } from "../api/review.js";
import { shortId } from "../lib/labels.js";

const BODY: React.CSSProperties = { fontSize: 14, color: "var(--aiq-color-fg-primary)" };
const MUTED: React.CSSProperties = { fontSize: 12, color: "var(--aiq-color-fg-muted)" };
const CELL: React.CSSProperties = { padding: "6px 8px", textAlign: "left", verticalAlign: "top", borderBottom: "1px solid var(--aiq-color-border)" };

const OUTCOME_LABEL: Record<AffectedReviewOutcome, string> = {
  no_change_needed: "No change needed",
  needs_follow_up: "Needs follow-up",
};

type Filter = "all" | "yes" | "no";

function ReviewControl({
  questionId,
  item,
  onSaved,
}: {
  questionId: string;
  item: AffectedAttemptItem;
  onSaved: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<AffectedReviewOutcome>(item.review?.outcome ?? "no_change_needed");
  const [note, setNote] = useState(item.review?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await putAffectedAttemptReviewApi(questionId, item.attempt_id, { outcome, ...(note.trim() ? { note: note.trim() } : {}) });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Could not save the review. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <HelpTip helpId="admin.question_bank.review.affected_mark">
        <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setOpen(true)}>
          {item.review ? "Change review" : "Mark reviewed"}
        </button>
      </HelpTip>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={BODY}>
        Outcome{" "}
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as AffectedReviewOutcome)}>
          <option value="no_change_needed">{OUTCOME_LABEL.no_change_needed}</option>
          <option value="needs_follow_up">{OUTCOME_LABEL.needs_follow_up}</option>
        </select>
      </label>
      <label style={BODY}>
        Note (optional)
        <textarea
          value={note}
          maxLength={1000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          style={{ display: "block", width: "100%" }}
        />
      </label>
      {error ? <p role="alert" style={{ ...BODY, margin: 0, color: "var(--aiq-color-danger)" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          Save review
        </button>
        <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AffectedAttemptsPanel({ questionId, id, reloadKey = 0 }: { questionId: string; id?: string; reloadKey?: number }): React.ReactElement {
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<AffectedAttemptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getAffectedAttemptsApi(questionId, filter === "all" ? undefined : filter)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof AdminApiError ? err.apiError.message : "Could not load the attempts. Try again.");
      });
    return () => { cancelled = true; };
  }, [questionId, filter, tick, reloadKey]);

  return (
    <section
      id={id}
      aria-label="Affected attempts"
      style={{ border: "1px dashed var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", padding: "var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: 8 }}
    >
      <p style={{ ...BODY, margin: 0, fontWeight: 600 }}>
        A corrected key does not change any mark. Review each attempt by hand. Automatic rescoring is not available.
      </p>
      {error ? <p role="alert" style={{ ...BODY, margin: 0, color: "var(--aiq-color-danger)" }}>{error}</p> : null}
      {!error && data === null ? <p role="status" style={{ ...BODY, margin: 0 }}>Loading the attempts.</p> : null}
      {data !== null ? (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <HelpTip helpId="admin.question_bank.review.affected_filter">
              <label style={BODY}>
                Show{" "}
                <select aria-label="Filter by review" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                  <option value="all">All attempts</option>
                  <option value="no">Not reviewed yet</option>
                  <option value="yes">Reviewed</option>
                </select>
              </label>
            </HelpTip>
            <span role="status" aria-live="polite" style={BODY}>
              {data.total === 0
                ? "No attempt matches."
                : `${data.total} ${data.total === 1 ? "attempt" : "attempts"} used an older version. The current version is ${data.current_version}.`}
            </span>
          </div>
          {data.items.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ ...BODY, width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Assessment", "Attempt", "Version used", "Current version", "Score on this question", "Released", "Review", ""].map((h) => (
                      <th key={h} scope="col" style={{ ...CELL, ...MUTED }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => (
                    <tr key={a.attempt_id}>
                      <td style={CELL}>{a.assessment_name}</td>
                      <td style={{ ...CELL, fontFamily: "var(--aiq-font-mono)" }}>{shortId(a.attempt_id)}</td>
                      <td style={CELL}>{a.question_version}</td>
                      <td style={CELL}>{a.current_version}</td>
                      <td style={CELL}>{a.score_earned === null ? "Not marked" : `${a.score_earned} of ${a.score_max ?? "?"}`}</td>
                      <td style={CELL}>{a.released ? "Yes" : "No"}</td>
                      <td style={CELL}>
                        {a.review ? (
                          <div>
                            <div>{OUTCOME_LABEL[a.review.outcome]}</div>
                            <div style={MUTED}>{`${a.review.reviewed_by_name ?? "An admin"} · ${formatDateTime(a.review.reviewed_at)}`}</div>
                            {a.review.note ? <div style={{ ...MUTED, whiteSpace: "pre-wrap" }}>{a.review.note}</div> : null}
                          </div>
                        ) : (
                          <span style={MUTED}>Not reviewed</span>
                        )}
                      </td>
                      <td style={CELL}>
                        <ReviewControl questionId={questionId} item={a} onSaved={reload} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.total > data.items.length ? <div style={MUTED}>{`Showing the first ${data.items.length} of ${data.total}.`}</div> : null}
        </>
      ) : null}
    </section>
  );
}
