import { useEffect, useRef, useState } from "react";

/** Whole seconds left until `endsAtIso`, never below zero. */
export function secondsLeft(endsAtIso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(endsAtIso) - nowMs) / 1000));
}

export interface QuestionCountdownProps {
  /** ISO time when this question's own time ends (from the position call). */
  endsAt: string;
  /** Called once, when the time reaches zero. */
  onExpire: () => void;
}

/** FUT-7: a plain countdown for the current question. Renders nothing once time is up. */
export function QuestionCountdown({ endsAt, onExpire }: QuestionCountdownProps): React.JSX.Element | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedRef = useRef(false);
  const left = secondsLeft(endsAt, nowMs);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (left === 0 && !firedRef.current) {
      firedRef.current = true;
      onExpire();
    }
  }, [left, onExpire]);

  if (left === 0) return null;
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return (
    <p
      role="timer"
      data-help-id="candidate.attempt.question_timer"
      style={{
        margin: "0 0 var(--aiq-space-sm)",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        color: "var(--aiq-color-fg-secondary)",
      }}
    >
      Time left for this question: {m}:{s}
    </p>
  );
}
