// Numeric question input — "enter the value". Stored answer is a bare number
// (or null when empty / not a number). The answer key never reaches here: the
// candidate view carries only { question, unit }.

import { useState } from 'react';

/** "12.5" / "1,250" / " -3 " -> number; anything else (or empty) -> null. */
export function parseNumericInput(raw: string): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function NumericAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: { question_id: string; content: unknown };
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  const unit = (question.content as { unit?: unknown } | null)?.unit;
  // Local draft so "12." or a half-typed value is not rewritten under the cursor.
  const [text, setText] = useState<string>(typeof answer === 'number' ? String(answer) : '');
  const invalid = text.trim() !== '' && parseNumericInput(text) === null;
  const errId = `num-err-${question.question_id}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xs)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--aiq-space-sm)' }}>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          disabled={disabled}
          aria-label="Your answer (a number)"
          aria-invalid={invalid}
          aria-describedby={invalid ? errId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            onAnswerChange(parseNumericInput(e.target.value)); // invalid/empty -> null (unanswered)
          }}
          onBlur={onBlur}
          style={{
            width: 220,
            maxWidth: '100%',
            padding: 'var(--aiq-space-md)',
            fontFamily: 'var(--aiq-font-mono)',
            fontSize: 'var(--aiq-answer-input-size)',
            color: 'var(--aiq-color-fg-primary)',
            background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
            border: `1px solid ${invalid ? 'var(--aiq-color-danger, #c0392b)' : 'var(--aiq-color-border)'}`,
            borderRadius: 'var(--aiq-radius-md)',
          }}
        />
        {typeof unit === 'string' && unit !== '' && (
          <span style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 15, color: 'var(--aiq-color-fg-muted)' }}>
            {unit}
          </span>
        )}
      </div>
      {invalid && (
        <span id={errId} role="alert" style={{ fontSize: 13, color: 'var(--aiq-color-danger, #c0392b)' }}>
          Enter a number, for example 12.5 or 1,250.
        </span>
      )}
    </div>
  );
}
