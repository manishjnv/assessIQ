import { useEffect, useRef } from 'react';

// Ordering question — "put these items in the right order". The candidate gets the
// items in a per-attempt shuffled order (never the correct one). Stored answer is
// { order: number[] }: the DISPLAYED item positions in the order the candidate placed
// them; the server translates to original item indexes. `correct_order` never reaches here.

/** The candidate's current arrangement: a valid permutation of 0..n-1, else the shown order. */
export function currentOrdering(answer: unknown, n: number): number[] {
  const raw = (answer as { order?: unknown } | null)?.order;
  if (
    Array.isArray(raw) &&
    raw.length === n &&
    new Set(raw).size === n &&
    raw.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n)
  ) {
    return raw as number[];
  }
  return Array.from({ length: n }, (_, i) => i);
}

/** Swap the entry at `pos` with its neighbour (dir -1 = up, +1 = down). Out of range = unchanged. */
export function moveItem(order: readonly number[], pos: number, dir: -1 | 1): number[] {
  const to = pos + dir;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[pos], next[to]] = [next[to] as number, next[pos] as number];
  return next;
}

export function OrderingAnswerArea({
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
  const raw = (question.content as { items?: unknown } | null)?.items;
  const items: string[] = Array.isArray(raw) ? (raw as string[]) : [];
  const order = currentOrdering(answer, items.length);
  // After a move, keep keyboard focus on the same button of the item's new row.
  const focusRef = useRef<{ pos: number; dir: -1 | 1 } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const f = focusRef.current;
    if (f === null) return;
    focusRef.current = null;
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>(`[data-move="${f.dir}"]`);
    const target = btns?.[f.pos];
    if (target !== undefined && !target.disabled) target.focus();
    else (btns?.[f.pos]?.closest('li')?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  });

  const move = (pos: number, dir: -1 | 1): void => {
    focusRef.current = { pos: pos + dir, dir };
    onAnswerChange({ order: moveItem(order, pos, dir) });
  };

  const btn = (disabledNow: boolean): React.CSSProperties => ({
    minWidth: 44,
    minHeight: 44,
    border: '1px solid var(--aiq-color-border)',
    borderRadius: 'var(--aiq-radius-md)',
    background: 'var(--aiq-color-bg-base)',
    color: 'var(--aiq-color-fg-primary)',
    cursor: disabledNow ? 'not-allowed' : 'pointer',
    opacity: disabledNow ? 0.4 : 1,
  });

  return (
    <div>
      <p id={`order-hint-${question.question_id}`} style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '0 0 var(--aiq-space-sm)' }}>
        Use the Up and Down buttons to put the items in the correct order, first to last.
      </p>
      <ol
        ref={listRef}
        aria-describedby={`order-hint-${question.question_id}`}
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}
      >
        {order.map((itemIdx, pos) => (
          <li
            key={itemIdx}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--aiq-space-md)',
              padding: 'var(--aiq-space-sm) var(--aiq-space-lg)',
              background: 'var(--aiq-color-bg-base)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
            }}
          >
            <span style={{ fontFamily: 'var(--aiq-font-mono)', fontSize: 12, color: 'var(--aiq-color-fg-muted)', width: 20 }}>
              {pos + 1}.
            </span>
            <span style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 15, lineHeight: 1.5, color: 'var(--aiq-color-fg-primary)', flex: 1 }}>
              {items[itemIdx]}
            </span>
            <button
              type="button"
              data-move="-1"
              aria-label={`Move item ${pos + 1} up`}
              disabled={disabled || pos === 0}
              onClick={() => move(pos, -1)}
              style={btn(disabled || pos === 0)}
            >
              <span aria-hidden="true">&#9650;</span>
            </button>
            <button
              type="button"
              data-move="1"
              aria-label={`Move item ${pos + 1} down`}
              disabled={disabled || pos === order.length - 1}
              onClick={() => move(pos, 1)}
              style={btn(disabled || pos === order.length - 1)}
            >
              <span aria-hidden="true">&#9660;</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
