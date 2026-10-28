// Z-167: progress row — "QUESTION 03 / 18", segmented bar (answered / flagged / current / open), answered count.
// Presentation only: segments call the same requestQuestion as the navigator.
import { SR_ONLY } from "./shared.js";

export interface ProgressSegment {
  questionId: string;
  position: number;
  status: "unanswered" | "answered" | "flagged" | "current";
  answered: boolean;
}

export function ProgressRow(props: {
  items: ProgressSegment[];
  safeIdx: number;
  answeredCount: number;
  onJump: (questionId: string) => void;
}): React.JSX.Element {
  const { items, safeIdx, answeredCount, onJump } = props;
  const total = items.length;
  const pct = total > 0 ? Math.round((answeredCount / total) * 100) : 0;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    <div className="aiq-take-progress">
      <span className="aiq-take-progress-count" aria-hidden="true">
        QUESTION <b>{pad(safeIdx + 1)}</b> / {pad(total)}
      </span>
      <span style={SR_ONLY}>{`Question ${safeIdx + 1} of ${total}`}</span>
      <div
        className="aiq-take-segs"
        role="group"
        aria-label="Progress"
      >
        {items.map((it) => (
          <button
            key={it.questionId}
            type="button"
            tabIndex={-1}
            data-s={it.status === "unanswered" ? "open" : it.status === "current" ? "current" : it.status}
            aria-label={`Go to question ${it.position}`}
            onClick={() => onJump(it.questionId)}
          />
        ))}
      </div>
      <span className="aiq-take-progress-right">{answeredCount} answered · {pct}%</span>
    </div>
  );
}
