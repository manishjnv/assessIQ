// Multi-select question — "select all that apply". Stored answer is
// { selected: number[] } in the DISPLAYED option order; the server translates
// to original indexes when the options were shuffled. `correct` never reaches here.

export function MultiSelectAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
}: {
  question: { question_id: string; content: unknown };
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
}): React.JSX.Element {
  const raw = (question.content as { options?: unknown } | null)?.options;
  const options: string[] = Array.isArray(raw) ? (raw as string[]) : [];
  const sel = (answer as { selected?: unknown } | null)?.selected;
  const selected: number[] = Array.isArray(sel) ? sel.filter((i): i is number => typeof i === 'number') : [];

  const toggle = (idx: number): void => {
    const next = selected.includes(idx) ? selected.filter((i) => i !== idx) : [...selected, idx].sort((a, b) => a - b);
    onAnswerChange({ selected: next });
  };

  return (
    <fieldset
      style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}
    >
      <legend style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', marginBottom: 'var(--aiq-space-sm)' }}>
        Select all that apply
      </legend>
      {options.map((text, idx) => {
        const on = selected.includes(idx);
        return (
          <label
            key={idx}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--aiq-space-md)',
              padding: 'var(--aiq-space-md) var(--aiq-space-lg)',
              background: on ? 'var(--aiq-color-accent-soft)' : 'var(--aiq-color-bg-base)',
              border: `1px solid ${on ? 'var(--aiq-color-accent)' : 'var(--aiq-color-border)'}`,
              borderRadius: 'var(--aiq-radius-md)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              name={question.question_id}
              value={String(idx)}
              checked={on}
              disabled={disabled}
              onChange={() => toggle(idx)}
              style={{ width: 18, height: 18, accentColor: 'var(--aiq-color-accent)', flexShrink: 0 }}
            />
            <span style={{ fontFamily: 'var(--aiq-font-mono)', fontSize: 11, color: 'var(--aiq-color-fg-muted)', width: 14 }}>
              {String.fromCharCode(65 + idx)}
            </span>
            <span style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 15, lineHeight: 1.5, color: 'var(--aiq-color-fg-primary)', flex: 1 }}>
              {text}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
