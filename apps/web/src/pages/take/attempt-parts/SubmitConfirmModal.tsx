import { Button, Modal } from "@assessiq/ui-system";
import type { CandidateAttemptViewWire } from "@assessiq/candidate-ui";

export interface SubmitConfirmModalProps {
  confirmOpen: boolean;
  submitting: boolean;
  submitError: string | null;
  setConfirmOpen: (open: boolean) => void;
  sectionLines: NonNullable<CandidateAttemptViewWire["sections_summary"]>;
  answeredCount: number;
  totalCount: number;
  overallUnanswered: number;
  flaggedCount: number;
  handleSubmit: () => Promise<void>;
}

/** Z-7 owner wording. n = unanswered questions; the last sentence is left out when n is 0. */
export function submitBody(n: number): string {
  const base = 'This sends your answers to your organisation and ends your test. You cannot change them after this.';
  return n > 0 ? `${base} You have ${n} unanswered question${n === 1 ? '' : 's'}.` : base;
}

export function SubmitConfirmModal(props: SubmitConfirmModalProps): React.JSX.Element {
  const {
    confirmOpen, submitting, submitError, setConfirmOpen, sectionLines, answeredCount,
    totalCount, overallUnanswered, flaggedCount, handleSubmit,
  } = props;
  return (
  <Modal
    open={confirmOpen}
    onClose={() => {
      if (!submitting) setConfirmOpen(false);
    }}
    title="Submit your test?"
  >
    <div style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)' }}>
      {sectionLines.length === 0 ? (
        <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-fg-primary)' }}>
          You answered {answeredCount} of {totalCount} questions.
        </p>
      ) : (
        <ul
          data-help-id="candidate.attempt.submit_sections"
          style={{ margin: '0 0 8px', paddingLeft: 18, color: 'var(--aiq-color-fg-primary)' }}
        >
          {sectionLines.map((s) => (
            <li key={s.index}>
              {s.name}: {s.answered_count} of {s.question_count} answered
              {s.status === 'done' ? ' (closed, cannot be changed)' : ''}
            </li>
          ))}
        </ul>
      )}
      {flaggedCount > 0 && (
        <p style={{ margin: '0 0 8px' }}>
          {flaggedCount} question{flaggedCount !== 1 ? 's are' : ' is'} flagged for review.
        </p>
      )}
      <p style={{ margin: 0 }}>{submitBody(overallUnanswered)}</p>
      {submitError !== null && (
        <p role="alert" style={{ margin: '12px 0 0', color: 'var(--aiq-color-fg-primary)' }}>
          {submitError}
        </p>
      )}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--aiq-space-sm)' }}>
      <Button variant="outline" disabled={submitting} onClick={() => setConfirmOpen(false)}>
        Review answers
      </Button>
      <Button variant="primary" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? 'Submitting…' : 'Submit test'}
      </Button>
    </div>
  </Modal>
  );
}
