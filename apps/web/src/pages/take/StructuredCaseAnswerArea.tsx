// Structured case question: a narrative + optional log excerpt, then choice steps (radio for
// "one", checkboxes for "many"). Stored answer is { steps: { [stepId]: number[] } } in the order the
// options are shown (this type is not shuffled). `correct` / `explanation` never reach here.

interface CaseStep {
  id: string;
  prompt: string;
  select: 'one' | 'many';
  options: string[];
}

/** Picks per step id; anything malformed reads as no picks. */
export function currentPicks(answer: unknown): Record<string, number[]> {
  const raw = (answer as { steps?: unknown } | null)?.steps;
  const out: Record<string, number[]> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[id] = v.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0);
  }
  return out;
}

/** Next canonical answer after the candidate toggles option `idx` of a step. Empty steps are dropped. */
export function nextAnswer(
  answer: unknown,
  stepId: string,
  select: 'one' | 'many',
  idx: number,
): { steps: Record<string, number[]> } {
  const steps = { ...currentPicks(answer) };
  const cur = steps[stepId] ?? [];
  const next = select === 'one' ? [idx] : cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx].sort((a, b) => a - b);
  if (next.length === 0) delete steps[stepId];
  else steps[stepId] = next;
  return { steps };
}

function parseSteps(content: unknown): CaseStep[] {
  const raw = (content as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
    .map((s) => ({
      id: String(s['id'] ?? ''),
      prompt: typeof s['prompt'] === 'string' ? s['prompt'] : '',
      select: s['select'] === 'many' ? ('many' as const) : ('one' as const),
      options: Array.isArray(s['options']) ? (s['options'] as unknown[]).filter((o): o is string => typeof o === 'string') : [],
    }));
}

export function StructuredCaseAnswerArea({
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
  const c = (question.content ?? {}) as { context?: unknown; log_excerpt?: unknown };
  const context = typeof c.context === 'string' ? c.context : '';
  const log = typeof c.log_excerpt === 'string' ? c.log_excerpt : '';
  const steps = parseSteps(question.content);
  const picks = currentPicks(answer);

  return (
    <div data-help-id="candidate.attempt.structured_case" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xl)' }}>
      {context && (
        <p style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 16, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)', margin: 0, whiteSpace: 'pre-wrap' }}>
          {context}
        </p>
      )}
      {log && (
        <pre
          tabIndex={0}
          aria-label="Log excerpt"
          style={{
            fontFamily: 'var(--aiq-font-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--aiq-color-fg-primary)',
            background: 'var(--aiq-color-bg-raised)',
            border: '1px solid var(--aiq-color-border)',
            borderRadius: 'var(--aiq-radius-md)',
            padding: 'var(--aiq-space-md)',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            margin: 0,
          }}
        >
          {log}
        </pre>
      )}
      {steps.map((step, n) => {
        const chosen = picks[step.id] ?? [];
        const name = `sc-${question.question_id}-${step.id}`;
        return (
          <fieldset key={step.id} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}>
            <legend style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 15, fontWeight: 600, color: 'var(--aiq-color-fg-primary)', marginBottom: 'var(--aiq-space-xs)' }}>
              Step {n + 1}. {step.prompt}
              <span style={{ display: 'block', fontSize: 13, fontWeight: 400, color: 'var(--aiq-color-fg-muted)' }}>
                {step.select === 'many' ? 'Select all that apply' : 'Select one'}
              </span>
            </legend>
            {step.options.map((text, idx) => (
              <label
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--aiq-space-md)',
                  minHeight: 44,
                  padding: 'var(--aiq-space-sm) var(--aiq-space-lg)',
                  background: 'var(--aiq-color-bg-base)',
                  border: `1px solid ${chosen.includes(idx) ? 'var(--aiq-color-accent)' : 'var(--aiq-color-border)'}`,
                  borderRadius: 'var(--aiq-radius-md)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 'var(--aiq-answer-input-size)',
                  color: 'var(--aiq-color-fg-primary)',
                }}
              >
                <input
                  type={step.select === 'many' ? 'checkbox' : 'radio'}
                  name={name}
                  checked={chosen.includes(idx)}
                  disabled={disabled}
                  onChange={() => onAnswerChange(nextAnswer(answer, step.id, step.select, idx))}
                />
                <span>{text}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}
