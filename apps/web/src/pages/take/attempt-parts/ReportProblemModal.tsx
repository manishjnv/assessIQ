// EXP-28: "Report a problem" with the current question. A small modal: reason + optional note.
// Calls POST /api/me/attempts/:id/report. The report only goes to the review queue; it never changes the test.
import { useState } from "react";
import { Button, Modal } from "@assessiq/ui-system";
import { CandidateApiError, reportQuestion } from "@assessiq/candidate-ui";

const REASONS: ReadonlyArray<{ id: "wrong_answer" | "unclear" | "other"; label: string }> = [
  { id: "wrong_answer", label: "The answer looks wrong" },
  { id: "unclear", label: "The question is unclear" },
  { id: "other", label: "Something else" },
];

const FIELD: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 14,
  padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-base)",
  color: "var(--aiq-color-fg-primary)",
  width: "100%",
};

export function ReportProblemModal({ attemptId, questionId, open, onClose }: {
  attemptId: string;
  questionId: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState<"wrong_answer" | "unclear" | "other">("unclear");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setDone(false);
    setError(null);
    setNote("");
    onClose();
  }

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await reportQuestion(attemptId, questionId, reason, note.trim() === "" ? null : note.trim());
      setDone(true);
    } catch (err) {
      setError(err instanceof CandidateApiError ? err.apiError.message : "The report could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Report a problem">
      <div data-help-id="candidate.attempt.report" style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, lineHeight: 1.6, color: "var(--aiq-color-fg-secondary)" }}>
        {done ? (
          <p role="status" style={{ margin: "0 0 8px", color: "var(--aiq-color-fg-primary)" }}>
            Thank you. We will check this question. Your test is not changed.
          </p>
        ) : (
          <form onSubmit={(e) => { void send(e); }} aria-label="Report a problem with this question" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              What is wrong?
              <select style={FIELD} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                {REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              Tell us more (optional)
              <textarea style={FIELD} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <p style={{ margin: 0 }}>Keep answering. This does not stop your test or change your marks.</p>
            {error !== null && <p role="alert" style={{ margin: 0, color: "var(--aiq-color-danger)" }}>{error}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
              <Button variant="outline" type="button" onClick={close}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send report"}</Button>
            </div>
          </form>
        )}
      </div>
      {done && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={close}>Close</Button>
        </div>
      )}
    </Modal>
  );
}
