// MCQ option list — shared by the real attempt runner (Attempt.tsx) and the
// practice question on the pre-test landing (TokenLanding.tsx) so a candidate
// rehearses with the exact same control.

// mcq: { question, options: string[], correct: number, rationale? }
interface McqContent {
  question: string;
  options: string[];   // 4 option texts, indexed 0–3
  correct: number;     // not rendered to candidate
  rationale?: string;  // not rendered to candidate
}

export function McqAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
}: {
  question: { question_id: string; content: unknown };
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
}): JSX.Element {
  const content = question.content as McqContent;
  const options: string[] = Array.isArray(content?.options) ? (content.options as string[]) : [];
  // Canonical answer shape: { selected: number } — index into options[].
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { selected?: unknown })
      : null;
  const selected: number | null =
    typeof answerObj?.selected === 'number' ? answerObj.selected : null;

  return (
    <div role="radiogroup" aria-label="Answer options" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}>
      {options.map((text, idx) => {
        const isSelected = selected === idx;
        const letter = String.fromCharCode(65 + idx); // A, B, C, D
        return (
          <label
            key={idx}
            style={{ display: 'block', cursor: disabled ? 'not-allowed' : 'pointer' }}
          >
            <input
              type="radio"
              name={question.question_id}
              value={String(idx)}
              checked={isSelected}
              disabled={disabled}
              onChange={() => onAnswerChange({ selected: idx })}
              style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--aiq-space-md)',
                padding: 'var(--aiq-space-md) var(--aiq-space-lg)',
                background: isSelected ? 'var(--aiq-color-accent-soft)' : 'var(--aiq-color-bg-base)',
                border: isSelected
                  ? '1px solid var(--aiq-color-accent)'
                  : '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-md)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'border-color 150ms ease, background 150ms ease',
                userSelect: 'none',
              }}
            >
              {/* Radio circle */}
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  border: `1.5px solid ${isSelected ? 'var(--aiq-color-accent)' : 'var(--aiq-color-border-strong)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'border-color 150ms ease',
                }}
              >
                {isSelected && (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: 'var(--aiq-color-accent)',
                    }}
                  />
                )}
              </span>
              {/* Letter label */}
              <span
                style={{
                  fontFamily: 'var(--aiq-font-mono)',
                  fontSize: 11,
                  color: 'var(--aiq-color-fg-muted)',
                  width: 14,
                  flexShrink: 0,
                }}
              >
                {letter}
              </span>
              {/* Option text */}
              <span
                style={{
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 15,
                  color: 'var(--aiq-color-fg-primary)',
                  lineHeight: 1.5,
                  flex: 1,
                }}
              >
                {text}
              </span>
            </div>
          </label>
        );
      })}
    </div>
  );
}
