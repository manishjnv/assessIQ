// Public "Try a sample assessment" demo — route /try (no RequireSession, no account).
//
// Static bundled content, client-side deterministic scoring, ZERO network
// requests (no api.ts, no fetch, no AI, no DB, no email). It reuses the real
// runner's presentational pieces (AttemptTimer, AutosaveIndicator,
// QuestionNavigator, the MCQ / multi-select / numeric answer areas) with pure
// props — Attempt.tsx is deliberately not touched.
//
// Autosave note: the indicator mirrors the real runner's states, but here
// answers live only in this tab's memory; the page says so.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Chip, Logo, Modal, ScoreRing } from '@assessiq/ui-system';
import { AttemptTimer, AutosaveIndicator, QuestionNavigator } from '@assessiq/candidate-ui';
import type { AutosaveStatus, NavigatorItem } from '@assessiq/candidate-ui';
import { McqAnswerArea } from '../take/McqAnswerArea';
import { MultiSelectAnswerArea } from '../take/MultiSelectAnswerArea';
import { NumericAnswerArea } from '../take/NumericAnswerArea';
import {
  DEMO_MINUTES,
  DEMO_QUESTIONS,
  PASS_PERCENT,
  SHARE_URL,
  describeAnswer,
  isAnswered,
  scoreDemo,
  shareLinks,
  type DemoAnswer,
  type DemoAnswers,
  type DemoQuestion,
} from './demoContent';

type Phase = 'intro' | 'run' | 'result';

const EYEBROW: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const PAGE: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--aiq-color-bg-base)',
  color: 'var(--aiq-color-fg-primary)',
  fontFamily: 'var(--aiq-font-sans)',
  overflowX: 'hidden',
};

const WRAP: CSSProperties = { maxWidth: 760, margin: '0 auto', padding: '16px' };

export function TryPage(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('intro');
  const [answers, setAnswers] = useState<DemoAnswers>({});
  const [endsAt, setEndsAt] = useState<string>('');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Try a sample assessment | AssessIQ';
    return () => {
      document.title = prev;
    };
  }, []);

  const begin = (): void => {
    setAnswers({});
    setTimedOut(false);
    setEndsAt(new Date(Date.now() + DEMO_MINUTES * 60_000).toISOString());
    setPhase('run');
  };

  return (
    <div className="aiq-attempt-shell" style={PAGE}>
      {phase === 'intro' && <Intro onBegin={begin} />}
      {phase === 'run' && (
        <Runner
          endsAt={endsAt}
          answers={answers}
          setAnswers={setAnswers}
          onFinish={(byTimer) => {
            setTimedOut(byTimer);
            setPhase('result');
          }}
        />
      )}
      {phase === 'result' && <Result answers={answers} timedOut={timedOut} onRetry={begin} />}
    </div>
  );
}

// ── intro ────────────────────────────────────────────────────────────────────

function Intro({ onBegin }: { onBegin: () => void }): React.JSX.Element {
  return (
    <main style={{ ...WRAP, paddingTop: 48 }}>
      <Logo size={28} showWordmark />
      <p style={{ ...EYEBROW, marginTop: 40, marginBottom: 8 }}>Sample assessment &middot; demo</p>
      <h1
        style={{
          fontFamily: 'var(--aiq-font-serif)',
          fontWeight: 400,
          fontSize: 'clamp(30px, 6vw, 44px)',
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          margin: '0 0 16px',
        }}
      >
        Try a sample assessment.
      </h1>
      <p style={{ fontSize: 17, lineHeight: 1.55, color: 'var(--aiq-color-fg-secondary)', margin: '0 0 24px' }}>
        {DEMO_QUESTIONS.length} questions, {DEMO_MINUTES} minutes, the same screens a candidate sees in a real
        AssessIQ assessment. No login and no account. Your answers are scored in your browser and are not sent or
        stored anywhere.
      </p>
      <Card padding="lg">
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 15 }}>
          <li>Question types: multiple choice, numeric, select-all, log analysis and a written answer.</li>
          <li>A countdown timer runs. When it reaches zero your answers are submitted and scored.</li>
          <li>
            You get a score with a per-question breakdown and model answers. The written answer is not scored
            here: in a real assessment it is graded by AssessIQ.
          </li>
        </ul>
      </Card>
      <div style={{ marginTop: 24 }}>
        <Button size="lg" onClick={onBegin} data-test-id="try-begin">
          Start the sample assessment
        </Button>
      </div>
    </main>
  );
}

// ── runner ───────────────────────────────────────────────────────────────────

function Runner({
  endsAt,
  answers,
  setAnswers,
  onFinish,
}: {
  endsAt: string;
  answers: DemoAnswers;
  setAnswers: (fn: (prev: DemoAnswers) => DemoAnswers) => void;
  onFinish: (byTimer: boolean) => void;
}): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [save, setSave] = useState<{ status: AutosaveStatus; at: string | null }>({ status: 'idle', at: null });
  const q = DEMO_QUESTIONS[idx]!;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    headingRef.current?.focus();
  }, [idx]);

  const setAnswer = (id: string, value: DemoAnswer): void => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    // Simulated autosave — in-memory only (see header comment).
    setSave((s) => ({ ...s, status: 'saving' }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => setSave({ status: 'saved', at: new Date().toISOString() }),
      400,
    );
  };

  const items: NavigatorItem[] = DEMO_QUESTIONS.map((x, i) => ({
    questionId: x.id,
    position: i + 1,
    status: i === idx ? 'current' : isAnswered(answers[x.id]) ? 'answered' : 'unanswered',
  }));
  const unanswered = DEMO_QUESTIONS.filter((x) => !isAnswered(answers[x.id])).length;
  const last = idx === DEMO_QUESTIONS.length - 1;

  return (
    <main style={WRAP}>
      <header
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}
      >
        <Logo size={24} showWordmark />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Chip variant="warn">Demo</Chip>
          <AutosaveIndicator status={save.status} lastSavedAt={save.at} />
          <AttemptTimer endsAt={endsAt} onExpire={() => finishRef.current(true)} data-test-id="try-timer" />
        </div>
      </header>
      <p style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '8px 0 0' }}>
        Autosave is shown as in a real assessment. In this demo your answers stay in this tab only.
      </p>

      <QuestionNavigator
        items={items}
        onSelect={(id) => setIdx(DEMO_QUESTIONS.findIndex((x) => x.id === id))}
        data-test-id="try-navigator"
      />

      <Card padding="lg">
        <p style={{ ...EYEBROW, margin: '0 0 8px' }}>
          Question {idx + 1} of {DEMO_QUESTIONS.length} &middot; {q.typeLabel}
          {q.points > 0 ? ` · ${q.points} points` : ' · not scored in the demo'}
        </p>
        <h1
          ref={headingRef}
          tabIndex={-1}
          style={{ fontSize: 20, fontWeight: 500, lineHeight: 1.4, margin: '0 0 16px', outline: 'none' }}
        >
          {q.prompt}
        </h1>
        {q.excerpt && (
          <pre
            tabIndex={0}
            aria-label="Log excerpt"
            style={{
              margin: '0 0 16px',
              padding: 12,
              overflowX: 'auto',
              background: 'var(--aiq-color-bg-raised)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {q.excerpt}
          </pre>
        )}
        <AnswerArea key={q.id} q={q} answer={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
      </Card>

      <nav
        aria-label="Question controls"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16, justifyContent: 'space-between' }}
      >
        <Button variant="outline" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
          Previous
        </Button>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {!last && (
            <Button variant="outline" onClick={() => setIdx(idx + 1)}>
              Next
            </Button>
          )}
          <Button onClick={() => setConfirmOpen(true)} data-test-id="try-submit">
            Submit assessment
          </Button>
        </div>
      </nav>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Submit your assessment?" width={440}>
        <p style={{ margin: '0 0 8px', fontSize: 15, lineHeight: 1.5 }}>
          {unanswered === 0
            ? 'You have answered every question.'
            : `${unanswered} of ${DEMO_QUESTIONS.length} questions are unanswered.`}{' '}
          Once you submit you cannot change your answers.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>
            Go back
          </Button>
          <Button onClick={() => onFinish(false)} data-test-id="try-confirm-submit">
            Submit assessment
          </Button>
        </div>
      </Modal>
    </main>
  );
}

const TEXTAREA: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 140,
  padding: 'var(--aiq-space-md)',
  fontFamily: 'var(--aiq-font-sans)',
  fontSize: 'var(--aiq-answer-input-size, 16px)',
  lineHeight: 1.5,
  color: 'var(--aiq-color-fg-primary)',
  background: 'var(--aiq-color-bg-base)',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-md)',
  resize: 'vertical',
};

function AnswerArea({
  q,
  answer,
  onChange,
}: {
  q: DemoQuestion;
  answer: DemoAnswer;
  onChange: (v: DemoAnswer) => void;
}): React.JSX.Element {
  const question = { question_id: q.id, content: { options: q.options, unit: q.unit } };
  if (q.type === 'mcq' || q.type === 'log') {
    return (
      <McqAnswerArea
        question={question}
        answer={typeof answer === 'number' ? { selected: answer } : null}
        disabled={false}
        onAnswerChange={(v) => onChange((v as { selected: number }).selected)}
      />
    );
  }
  if (q.type === 'multi_select') {
    return (
      <MultiSelectAnswerArea
        question={question}
        answer={{ selected: Array.isArray(answer) ? answer : [] }}
        disabled={false}
        onAnswerChange={(v) => onChange((v as { selected: number[] }).selected)}
      />
    );
  }
  if (q.type === 'numeric') {
    return (
      <NumericAnswerArea
        question={question}
        answer={answer}
        disabled={false}
        onAnswerChange={(v) => onChange(v as number | null)}
        onBlur={() => {}}
      />
    );
  }
  return (
    <>
      <label htmlFor={`ans-${q.id}`} style={{ display: 'block', fontSize: 13, color: 'var(--aiq-color-fg-muted)', marginBottom: 8 }}>
        Your answer
      </label>
      <textarea
        id={`ans-${q.id}`}
        style={TEXTAREA}
        value={typeof answer === 'string' ? answer : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

// ── result ───────────────────────────────────────────────────────────────────

function Result({
  answers,
  timedOut,
  onRetry,
}: {
  answers: DemoAnswers;
  timedOut: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const result = useMemo(() => scoreDemo(answers), [answers]);
  const links = shareLinks(result.percent);
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      setCopied(true);
    } catch {
      window.prompt('Copy this link', SHARE_URL);
    }
  };

  const linkStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 44,
    padding: '0 16px',
    border: '1px solid var(--aiq-color-border-strong)',
    borderRadius: 'var(--aiq-radius-pill)',
    color: 'var(--aiq-color-fg-primary)',
    textDecoration: 'none',
    fontSize: 14,
  };

  return (
    <main style={WRAP}>
      <Logo size={24} showWordmark />
      <p style={{ ...EYEBROW, marginTop: 32, marginBottom: 8 }}>Sample assessment &middot; result</p>
      <h1 style={{ fontFamily: 'var(--aiq-font-serif)', fontWeight: 400, fontSize: 32, margin: '0 0 8px' }}>
        {timedOut ? 'Time is up. Here is your score.' : 'Your score'}
      </h1>

      <Card padding="lg">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <ScoreRing value={Math.round(result.percent)} size="lg" label="Score" />
          <div>
            <p data-test-id="try-score" style={{ fontSize: 28, fontWeight: 500, margin: 0 }}>
              {result.earned} / {result.max} points ({result.percent}%)
            </p>
            <p style={{ margin: '8px 0 0' }}>
              <Chip variant={result.passed ? 'success' : 'warn'}>
                {result.passed ? 'Passed' : 'Not passed'} &middot; pass mark {PASS_PERCENT}%
              </Chip>
            </p>
            <p style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '8px 0 0' }}>
              The written answer is not scored in this demo.
            </p>
          </div>
        </div>
      </Card>

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Question breakdown</h2>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {result.rows.map(({ q, earned, answered }, i) => (
          <li key={q.id}>
            <Card padding="md">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={EYEBROW}>
                  Q{i + 1} &middot; {q.typeLabel}
                </span>
                {q.points === 0 ? (
                  <Chip>Not scored in demo</Chip>
                ) : (
                  <Chip variant={earned >= q.points ? 'success' : earned > 0 ? 'accent' : 'warn'}>
                    {earned} / {q.points}
                  </Chip>
                )}
              </div>
              <p style={{ margin: '0 0 8px', fontSize: 15, lineHeight: 1.5 }}>{q.prompt}</p>
              <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--aiq-color-fg-secondary)' }}>
                <strong>Your answer:</strong>{' '}
                <span style={{ whiteSpace: 'pre-wrap' }}>{answered ? describeAnswer(q, answers[q.id]) : 'Not answered'}</span>
              </p>
              <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--aiq-color-fg-secondary)' }}>
                <strong>Model answer:</strong> {q.modelAnswer}
              </p>
              {q.why && <p style={{ margin: 0, fontSize: 13, color: 'var(--aiq-color-fg-muted)' }}>{q.why}</p>}
              {q.type === 'written' && (
                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--aiq-color-fg-muted)' }}>
                  In a real assessment this is graded by AssessIQ.
                </p>
              )}
            </Card>
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Certificate</h2>
      <p style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--aiq-color-fg-secondary)' }}>
        Real assessments can issue a verifiable certificate. See what one looks like (a sample only, not a credential).
      </p>
      <Link to="/try/certificate" style={linkStyle}>
        View a sample certificate
      </Link>

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Share</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <a href={links.linkedin} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          Share on LinkedIn
        </a>
        <a href={links.x} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          Share on X
        </a>
        <a href={links.whatsapp} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          Share on WhatsApp
        </a>
        <button type="button" onClick={() => void copy()} style={{ ...linkStyle, background: 'transparent', cursor: 'pointer', font: 'inherit', fontSize: 14 }}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '32px 0 48px' }}>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
        <a href="/contact" style={{ ...linkStyle, background: 'var(--aiq-color-accent)', color: '#fff', border: 0 }}>
          Talk to us about real assessments
        </a>
      </div>
    </main>
  );
}
