// Pre-test blocks for the /take/:token landing: system check, practice
// question, consent. Pure client-side — nothing here is stored or scored.
// The practice question reuses McqAnswerArea (the real runner's control).

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button, Chip } from '@assessiq/ui-system';
import { McqAnswerArea } from './McqAnswerArea.js';

const SECTION: CSSProperties = {
  marginBottom: 16,
  padding: '14px 16px',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-md)',
  background: 'var(--aiq-color-bg-raised)',
};

const H2: CSSProperties = {
  fontFamily: 'var(--aiq-font-sans)',
  fontSize: 14,
  fontWeight: 600,
  margin: '0 0 10px',
  color: 'var(--aiq-color-fg-primary)',
};

// ─── System check ────────────────────────────────────────────────────────────

export type CheckStatus = 'checking' | 'ok' | 'warn' | 'fail';

export interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  /** Fix hint shown for warn / fail. */
  hint?: string;
}

async function serverReachable(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function storageAvailable(): boolean {
  try {
    const k = '__aiq_check__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return navigator.cookieEnabled !== false;
  } catch {
    return false;
  }
}

/** Runs the quick client-side checks once, plus on demand via `recheck`. */
export function useSystemCheck(): { rows: CheckRow[]; blocked: boolean; recheck: () => void } {
  const [rows, setRows] = useState<CheckRow[]>([]);

  const run = useCallback((): void => {
    const online = navigator.onLine !== false;
    const supported = typeof fetch === 'function' && typeof structuredClone === 'function';
    const narrow = window.innerWidth < 340;
    const base: CheckRow[] = [
      {
        id: 'online',
        label: 'Internet connection',
        status: online ? 'ok' : 'fail',
        hint: 'You appear to be offline. Reconnect, then check again.',
      },
      {
        id: 'storage',
        label: 'Cookies and storage',
        status: storageAvailable() ? 'ok' : 'warn', // warning only: Begin itself surfaces a real failure
        hint: 'Turn on cookies and site storage for this site (and leave private mode), then check again.',
      },
      {
        id: 'browser',
        label: 'Browser',
        status: supported ? 'ok' : 'fail',
        hint: 'Use the latest version of Chrome, Edge, Firefox or Safari.',
      },
      {
        id: 'screen',
        label: 'Screen size',
        status: narrow ? 'warn' : 'ok',
        hint: 'Your screen is very small. Rotate your phone or use a larger screen if you can.',
      },
      { id: 'server', label: 'Connection to AssessIQ', status: 'checking' },
    ];
    setRows(base);
    void serverReachable().then((ok) => {
      setRows((prev) =>
        prev.map((r) =>
          r.id === 'server'
            ? {
                ...r,
                status: ok ? 'ok' : 'warn', // warning only (health probe can fail while the app works)
                hint: 'We could not reach AssessIQ. Check your connection, then check again.',
              }
            : r,
        ),
      );
    });
  }, []);

  useEffect(() => {
    run();
    const again = (): void => run();
    window.addEventListener('online', again);
    window.addEventListener('offline', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('offline', again);
    };
  }, [run]);

  // Only offline / unsupported browser block Begin. Storage + server-reachability
  // are warnings (a flaky health probe must not lock out a candidate).
  const blocked =
    rows.length === 0 ||
    rows.some((r) => (r.id === 'online' || r.id === 'browser') && r.status === 'fail');
  return { rows, blocked, recheck: run };
}

const STATUS_CHIP: Record<CheckStatus, { variant: 'default' | 'success' | 'warn'; text: string }> = {
  checking: { variant: 'default', text: 'Checking' },
  ok: { variant: 'success', text: 'OK' },
  warn: { variant: 'warn', text: 'Heads up' },
  fail: { variant: 'warn', text: 'Fix needed' },
};

export function SystemCheck({
  rows,
  onRecheck,
}: {
  rows: CheckRow[];
  onRecheck: () => void;
}): JSX.Element {
  const problems = rows.filter((r) => (r.status === 'fail' || r.status === 'warn') && r.hint);
  const hasFail = rows.some((r) => r.status === 'fail' || r.status === 'warn');
  return (
    <section data-help-id="candidate.intro.system_check" aria-label="System check" style={SECTION}>
      <h2 style={H2}>System check</h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
        {rows.map((r) => (
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
            <Chip variant={STATUS_CHIP[r.status].variant}>{STATUS_CHIP[r.status].text}</Chip>
          </li>
        ))}
      </ul>
      {problems.length > 0 && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--aiq-color-fg-secondary)' }}>
          {problems.map((r) => (
            <p key={r.id} style={{ margin: '4px 0' }}>
              {r.hint}
            </p>
          ))}
        </div>
      )}
      {hasFail && (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" variant="outline" onClick={onRecheck}>
            Check again
          </Button>
        </div>
      )}
    </section>
  );
}

// ─── Practice question ───────────────────────────────────────────────────────

// Static, never stored, never scored.
const PRACTICE = {
  question_id: 'practice',
  content: {
    question: 'What is 15% of 200?',
    options: ['20', '25', '30', '35'],
  },
};

export function PracticeQuestion(): JSX.Element {
  const [answer, setAnswer] = useState<unknown>(null);
  return (
    <section data-help-id="candidate.intro.practice" aria-label="Practice question" style={SECTION}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ ...H2, margin: 0 }}>Try one first</h2>
        <Chip variant="default">Practice — not scored</Chip>
      </div>
      <p
        className="aiq-serif"
        style={{ fontSize: 18, lineHeight: 1.4, margin: '0 0 12px', color: 'var(--aiq-color-fg-primary)' }}
      >
        {PRACTICE.content.question}
      </p>
      <McqAnswerArea
        question={PRACTICE}
        answer={answer}
        disabled={false}
        onAnswerChange={setAnswer}
      />
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--aiq-color-fg-muted)' }}>
        {answer === null
          ? 'Pick an option to see how answering works. Nothing here is saved.'
          : 'That is all it takes. In the real test your choice saves automatically.'}
      </p>
    </section>
  );
}

// ─── Consent ─────────────────────────────────────────────────────────────────

export function ConsentBlock({
  name,
  company,
  checked,
  onChange,
}: {
  name: string;
  company: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  const link: CSSProperties = { color: 'inherit', textDecoration: 'underline' };
  return (
    <section data-help-id="candidate.intro.consent" style={{ marginBottom: 16 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          cursor: 'pointer',
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--aiq-color-fg-primary)',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: 3, flexShrink: 0 }}
        />
        <span>
          I confirm I am {name}, I will take this test on my own, and I agree to the{' '}
          <a href="/terms" target="_blank" rel="noopener noreferrer" style={link}>
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" style={link}>
            Privacy Policy
          </a>
          . Results may be shared with {company || 'the company that invited me'}.
        </span>
      </label>
      <p style={{ margin: '8px 0 0 26px', fontSize: 12, lineHeight: 1.5, color: 'var(--aiq-color-fg-muted)' }}>
        Multiple-choice answers are scored automatically. Written answers, if any, are evaluated
        with AI assistance and reviewed by the assessment admin.
      </p>
    </section>
  );
}
