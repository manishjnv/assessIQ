// Intro and result screens of the free no-login tests (/try/:exam/:set).
// Zero network, no email, no analytics beacon; the only storage is the best score per set in localStorage
// (try/catch inside freeTests.ts). No certificate and no percentile: the result is practice feedback only.
// Two modes: Mock (answers at the end) and Real (answers behind one click). Neither has a camera.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Button, Card, Chip, Logo, ScoreRing } from '@assessiq/ui-system';
import '../take/take-theme.css';
import { describeAnswer, scoreFree, type FreeAnswers, type FreeQuestion } from './freeScoring';
import {
  ALL_MODES,
  FREE_MODES,
  LEVELS,
  bandFor,
  bestLine,
  endHref,
  formatClock,
  formatTopic,
  getExam,
  itemsPerAttempt,
  paceLine,
  readBest,
  saveBest,
  sectionScores,
  shareText,
  weakestTopic,
  whatsappLink,
  type BestScores,
  type FreeSet,
  type Mode,
} from './freeTests';

// Breadcrumb link: 44 px tall tap area on a phone without moving the line (padding offset by negative margin).
export const CRUMB: CSSProperties = { color: 'inherit', display: 'inline-block', padding: '15px 0', margin: '-15px 0' };

export const EYEBROW: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};
export const WRAP: CSSProperties = { maxWidth: 760, margin: '0 auto', padding: '16px' };
export const LINK: CSSProperties = {
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
export const PRIMARY_LINK: CSSProperties = { ...LINK, background: 'var(--aiq-color-accent)', color: '#fff', border: 0 };

export const H1: CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  fontWeight: 400,
  fontSize: 'clamp(30px, 6vw, 44px)',
  lineHeight: 1.1,
  letterSpacing: '-0.02em',
  margin: '0 0 16px',
};

const examOf = (set: FreeSet) => getExam(set.exam)!;
const mixLine = (set: FreeSet): string => set.sections.map((x) => `${x.count} ${x.label.toLowerCase()}`).join(', ');

const MUTED13: CSSProperties = { fontSize: 13, color: 'var(--aiq-color-fg-muted)' };
const H2: CSSProperties = { fontSize: 18, fontWeight: 500, margin: '32px 0 12px' };

export function FreeIntro({
  set,
  mode,
  onMode,
  onBegin,
}: {
  set: FreeSet;
  mode: Mode;
  onMode: (m: Mode) => void;
  onBegin: () => void;
}): React.JSX.Element {
  const [best, setBest] = useState<BestScores>({});
  useEffect(() => setBest(readBest(set.exam)), [set.exam]);
  const exam = examOf(set);
  const total = itemsPerAttempt(set);
  const modes = exam.modes ?? ALL_MODES;
  const real = mode === 'real';
  return (
    <main style={{ ...WRAP, paddingTop: 48 }}>
      <Logo size={28} showWordmark href="/" />
      <p style={{ ...EYEBROW, marginTop: 40, marginBottom: 8 }}>
        <Link to={`/try/${set.exam}`} style={CRUMB}>
          Free {exam.title.toLowerCase()} tests
        </Link>{' '}
        &middot; {set.slug}
      </p>
      <h1 style={H1}>
        {set.title}: free {exam.title.toLowerCase()} test.
      </h1>
      <p style={{ fontSize: 'var(--aiq-text-lg)', lineHeight: 1.55, color: 'var(--aiq-color-fg-secondary)', margin: '0 0 24px' }}>
        {total} questions, {set.minutes} minutes: {mixLine(set)}. No login and no email. Your answers stay in your
        browser.
      </p>
      {modes.length > 1 && (
        <div className="aiq-take-seg" role="group" aria-label="Test mode" style={{ maxWidth: 420, marginTop: 0, marginBottom: 16 }} data-test-id="free-mode">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 12px' }}
            >
              <span>{FREE_MODES[m].label}</span>
              <span style={{ fontSize: 11, color: 'var(--aiq-color-fg-muted)' }}>{FREE_MODES[m].subtitle}</span>
            </button>
          ))}
        </div>
      )}
      <Card padding="lg">
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 'var(--aiq-text-lg)' }}>
          <li>A countdown timer runs. When it reaches zero your answers are submitted and scored.</li>
          {real ? (
            <li>
              Same screen as a real assessment: full screen where your browser allows it, a warning if you leave this
              window, and no answers until you ask. It is not proctored, nothing is recorded or sent, and the questions
              are public. It does not prove anything to anyone.
            </li>
          ) : (
            <li>You see your score and an explanation for every question.</li>
          )}
          <li>Practice only. Nothing is checked or sent.</li>
        </ul>
      </Card>
      {real && (
        <p style={{ ...MUTED13, margin: '12px 0 0' }}>
          Real mode is without camera. Organisations can add a camera in their own assessments.
        </p>
      )}
      <p style={{ ...EYEBROW, margin: '24px 0 8px' }}>Your best score on this device</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-test-id="free-progress">
        {LEVELS.map((s) => (
          <Chip key={s} {...(s === set.slug ? { variant: 'accent' as const } : {})}>
            {exam.sets[s].title}: {bestLine(best[s]) ?? 'not tried'}
          </Chip>
        ))}
      </div>
      <div style={{ marginTop: 24 }}>
        <Button size="lg" onClick={onBegin} data-test-id="try-begin">
          {real ? 'Start in Real mode' : `Start the ${set.slug} test`}
        </Button>
      </div>
    </main>
  );
}

export function FreeResult({
  set,
  mode,
  questions,
  answers,
  timedOut,
  usedSeconds,
  onRetry,
  onTryReal,
}: {
  set: FreeSet;
  mode: Mode;
  questions: FreeQuestion[];
  answers: FreeAnswers;
  timedOut: boolean;
  usedSeconds: number;
  onRetry: () => void;
  onTryReal: () => void;
}): React.JSX.Element {
  const real = mode === 'real';
  const result = useMemo(() => scoreFree(answers, questions), [answers, questions]);
  const sections = useMemo(() => sectionScores(set, result.rows), [result]);
  const weakest = useMemo(() => weakestTopic(result.rows), [result]);
  const [best, setBest] = useState<BestScores>({});
  // The best score is saved on arrival, before any answer is revealed.
  useEffect(() => setBest(saveBest(set.exam, set.slug, mode, result.percent)), [set.exam, set.slug, mode, result.percent]);
  const [revealed, setRevealed] = useState(false);
  const breakdownRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (revealed) breakdownRef.current?.focus();
  }, [revealed]);

  const band = bandFor(result.percent);
  const flags = result.rows.map((r) => r.earned >= r.q.points);
  const text = shareText(set, flags, usedSeconds, mode);
  const exam = examOf(set);
  const idx = LEVELS.indexOf(set.slug);
  const next = idx < LEVELS.length - 1 ? exam.sets[LEVELS[idx + 1]!] : null;
  const limit = set.minutes * 60;
  const wrong = result.rows.flatMap((r, i) => (r.answered && r.earned < r.q.points ? [i + 1] : []));
  const skipped = result.rows.flatMap((r, i) => (r.answered ? [] : [i + 1]));
  const qList = (a: number[]): string => (a.length > 0 ? a.map((n) => `Q${n}`).join(', ') : 'none');
  const bestText = bestLine(best[set.slug]);

  return (
    <main style={WRAP}>
      <Logo size={24} showWordmark href="/" />
      <p style={{ ...EYEBROW, marginTop: 32, marginBottom: 8 }}>
        Free {exam.title.toLowerCase()} test &middot; {set.slug} &middot; {real ? 'Real mode · ' : ''}result
      </p>
      <h1 style={{ fontFamily: 'var(--aiq-font-serif)', fontWeight: 400, fontSize: 'var(--aiq-text-2xl)', margin: '0 0 8px' }}>
        {real ? (timedOut ? 'Time is up. Here is your Real mode score.' : 'Your Real mode score') : timedOut ? 'Time is up. Here is your score.' : 'Your score'}
      </h1>

      <Card padding="lg">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <ScoreRing value={Math.round(result.percent)} size="lg" label="Score" />
          <div>
            <p data-test-id="free-score" style={{ fontSize: 'var(--aiq-text-2xl)', fontWeight: 500, margin: 0 }}>
              {flags.filter(Boolean).length} / {flags.length} correct ({result.percent}%)
            </p>
            <p style={{ margin: '8px 0 0' }}>
              <Chip variant={result.percent >= 70 ? 'success' : 'warn'} data-test-id="free-band">
                {band}
              </Chip>
            </p>
            <p style={{ ...MUTED13, margin: '8px 0 0' }}>
              Time {formatClock(usedSeconds)} of {formatClock(limit)}. {paceLine(result.percent, usedSeconds, limit)}
            </p>
            {bestText != null && <p style={{ ...MUTED13, margin: '4px 0 0' }}>Best on this device: {bestText}</p>}
          </div>
        </div>
      </Card>

      <h2 style={H2}>Sections</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-test-id="free-sections">
        {sections.map((s) => (
          <div key={s.section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
              <span>{s.label}</span>
              <span>
                {s.earned / 10} / {s.max / 10}
              </span>
            </div>
            <div
              role="img"
              aria-label={`${s.label} ${s.percent} percent`}
              style={{ height: 10, borderRadius: 5, background: 'var(--aiq-color-bg-raised)', overflow: 'hidden' }}
            >
              <div style={{ width: `${s.percent}%`, height: '100%', background: 'var(--aiq-color-accent)' }} />
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: '16px 0 0', fontSize: 'var(--aiq-text-lg)', color: 'var(--aiq-color-fg-secondary)' }} data-test-id="free-weakest">
        {weakest ? `Weakest topic: ${formatTopic(weakest)}.` : 'No weak topic: every topic is right.'}
      </p>

      {real && (
        <>
          <p style={{ margin: '12px 0 0', fontSize: 14 }} data-test-id="free-misses">
            Not correct: {qList(wrong)} &middot; Not answered: {qList(skipped)}
          </p>
          <p style={{ ...MUTED13, margin: '16px 0 8px' }}>
            In a real AssessIQ test, your organisation decides when you see answers. This is a free practice copy, so you can see
            them now.
          </p>
          {!revealed && (
            <Button variant="outline" onClick={() => setRevealed(true)} data-test-id="free-reveal">
              Show answers and explanations
            </Button>
          )}
        </>
      )}

      {(!real || revealed) && (
        <>
          <h2 ref={breakdownRef} tabIndex={-1} style={H2}>
            Question breakdown
          </h2>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {result.rows.map(({ q, earned, answered }, i) => (
              <li key={q.id} data-question-id={q.id}>
                <Card padding="md">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <span style={EYEBROW}>
                      Q{i + 1} &middot; {q.typeLabel} &middot; {formatTopic(q.topic ?? '')}
                    </span>
                    <Chip variant={earned >= q.points ? 'success' : 'warn'}>{earned >= q.points ? 'Correct' : 'Not correct'}</Chip>
                  </div>
                  <p style={{ margin: '0 0 8px', fontSize: 'var(--aiq-text-lg)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{q.prompt}</p>
                  <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--aiq-color-fg-secondary)' }}>
                    <strong>Your answer:</strong> {answered ? describeAnswer(q, answers[q.id]) : 'Not answered'}
                  </p>
                  <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--aiq-color-fg-secondary)' }}>
                    <strong>Correct answer:</strong> {q.modelAnswer}
                  </p>
                  {q.why && <p style={{ margin: 0, ...MUTED13 }}>{q.why}</p>}
                </Card>
              </li>
            ))}
          </ol>
        </>
      )}

      <h2 style={H2}>Share</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <a href={whatsappLink(text)} target="_blank" rel="noopener noreferrer" style={LINK} data-test-id="free-whatsapp">
          Share on WhatsApp
        </a>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '32px 0 8px' }}>
        {next && (
          <Link to={`/try/${set.exam}/${next.slug}${real ? '?mode=real' : ''}`} style={PRIMARY_LINK} data-test-id="free-next">
            Next: {next.title} test
          </Link>
        )}
        {!real && (exam.modes ?? ALL_MODES).includes('real') && (
          <Button variant="outline" onClick={onTryReal} data-test-id="free-try-real">
            Try it in Real mode
          </Button>
        )}
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
        <Link to={`/try/${set.exam}`} style={LINK} data-test-id="free-levels">
          All levels
        </Link>
        <a href={endHref(mode)} style={next ? LINK : PRIMARY_LINK} data-test-id="free-end">
          Bring this to your batch
        </a>
      </div>
      <p style={{ ...MUTED13, margin: '0 0 8px' }}>
        Run this for your batch with fresh questions, a camera option and results for each student. Free plan: 5 candidates.
      </p>
      <p style={{ ...MUTED13, margin: '0 0 48px' }}>Practice only, not a real test score.</p>
    </main>
  );
}
