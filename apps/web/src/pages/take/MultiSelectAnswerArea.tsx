import "./take-theme.css";

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
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '0 0 10px', padding: 0 }}>
        Select all that apply
      </legend>
      <div className="aiq-take-opts">
        {options.map((text, idx) => {
          const on = selected.includes(idx);
          return (
            <label key={idx} className="aiq-take-opt" data-checked={on} data-disabled={disabled}>
              <input
                type="checkbox"
                className="aiq-take-visually-hidden-input"
                name={question.question_id}
                value={String(idx)}
                checked={on}
                disabled={disabled}
                onChange={() => toggle(idx)}
              />
              <span className="aiq-take-opt-badge" aria-hidden="true">{String.fromCharCode(65 + idx)}</span>
              <span className="aiq-take-opt-text">{text}</span>
              <span className="aiq-take-check" aria-hidden="true">{on ? '✓' : null}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
