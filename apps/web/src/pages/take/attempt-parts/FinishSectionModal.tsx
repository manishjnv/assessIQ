import { Button, Modal } from "@assessiq/ui-system";
import type { CandidateAttemptViewWire } from "@assessiq/candidate-ui";

export interface FinishSectionModalProps {
  finishOpen: boolean;
  finishing: boolean;
  finishError: string | null;
  setFinishOpen: (open: boolean) => void;
  answeredCount: number;
  totalCount: number;
  sec: CandidateAttemptViewWire["sections"];
  handleFinishSection: (fromSection: number) => Promise<void>;
}

export function FinishSectionModal(props: FinishSectionModalProps): React.JSX.Element {
  const { finishOpen, finishing, finishError, setFinishOpen, answeredCount, totalCount, sec, handleFinishSection } = props;
  return (
  <Modal
    open={finishOpen}
    onClose={() => {
      if (!finishing) setFinishOpen(false);
    }}
    title="Finish this section?"
  >
    <div style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)' }}>
      <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-fg-primary)' }}>
        You can't come back to this section.
      </p>
      <p style={{ margin: 0 }}>
        You answered {answeredCount} of {totalCount} questions here. Unanswered questions will score 0.
      </p>
      {finishError !== null && (
        <p role="alert" style={{ margin: '12px 0 0', color: 'var(--aiq-color-fg-primary)' }}>
          {finishError}
        </p>
      )}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--aiq-space-sm)' }}>
      <Button variant="outline" disabled={finishing} onClick={() => setFinishOpen(false)}>
        Go back
      </Button>
      <Button
        variant="primary"
        disabled={finishing}
        onClick={() => void handleFinishSection(sec?.current ?? 0)}
      >
        {finishing ? 'Finishing…' : 'Finish section'}
      </Button>
    </div>
  </Modal>
  );
}
