// Z-91: readiness check panel on the /take/:token landing.
// REAL exam: Begin stays disabled until every row passes. MOCK: the same panel is an optional
// "dress rehearsal" and never blocks. The signals are sent in the /take/start body and the
// server runs its own check, so a hand-made request cannot skip this page.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button, Chip } from '@assessiq/ui-system';
import {
  collectDeviceSignals,
  collectReadinessSignals,
  evaluateReadinessRows,
  type DeviceSignals,
  type ReadinessRow,
  type ReadinessSignalsWire,
} from './readiness.js';

const SECTION: CSSProperties = {
  marginBottom: 16,
  padding: '14px 16px',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-md)',
  background: 'var(--aiq-color-bg-raised)',
};

export interface ReadinessState {
  rows: ReadinessRow[];
  running: boolean;
  /** True once the checks ran and every row passed. */
  passed: boolean;
  device: DeviceSignals | null;
  signals: ReadinessSignalsWire | null;
  retry: () => void;
}

/** Runs the checks on mount (when enabled) and on retry. */
export function useReadiness(enabled: boolean): ReadinessState {
  const [rows, setRows] = useState<ReadinessRow[]>([]);
  const [running, setRunning] = useState(false);
  const [device, setDevice] = useState<DeviceSignals | null>(null);
  const [signals, setSignals] = useState<ReadinessSignalsWire | null>(null);

  const run = useCallback((): void => {
    if (!enabled) return;
    setRunning(true);
    const d = collectDeviceSignals();
    setDevice(d);
    void collectReadinessSignals().then((s) => {
      setSignals(s);
      setRows(evaluateReadinessRows(s, d));
      setRunning(false);
    });
  }, [enabled]);

  useEffect(() => {
    run();
  }, [run]);

  const passed = !running && rows.length > 0 && rows.every((r) => r.status === 'ok');
  return { rows, running, passed, device, signals, retry: run };
}

export function ReadinessPanel({
  state,
  optional,
}: {
  state: ReadinessState;
  /** Mock test: shown as a dress rehearsal that never blocks Begin. */
  optional: boolean;
}): React.JSX.Element {
  const failed = state.rows.filter((r) => r.status === 'fail');
  return (
    <section data-help-id="candidate.intro.readiness" aria-label="Readiness check" style={SECTION}>
      <h2
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 14,
          fontWeight: 600,
          margin: '0 0 10px',
          color: 'var(--aiq-color-fg-primary)',
        }}
      >
        {optional ? 'Dress rehearsal (optional)' : 'Readiness check'}
      </h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
        {state.running && state.rows.length === 0 && (
          <li style={{ color: 'var(--aiq-color-fg-secondary)' }}>Checking your device…</li>
        )}
        {state.rows.map((r) => (
          <li
            key={r.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 0',
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            <span>{r.label}</span>
            <Chip variant={r.status === 'ok' ? 'success' : 'warn'}>{r.status === 'ok' ? 'Pass' : 'Fix needed'}</Chip>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--aiq-color-fg-secondary)' }}>
          {failed.map((r) => (
            <p key={r.id} style={{ margin: '4px 0' }}>
              {r.message}
            </p>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Button size="sm" variant="outline" onClick={state.retry} disabled={state.running}>
          {state.running ? 'Checking…' : 'Retry'}
        </Button>
      </div>
    </section>
  );
}
