// Intro and result screens of the free no-login tests (/try/:exam/:set).
// Zero network, no email, no analytics beacon; the only storage is the best score per set in localStorage
// (try/catch inside freeTests.ts). No certificate and no percentile: the result is practice feedback only.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Button, Card, Chip, Logo, ScoreRing } from '@assessiq/ui-system';
import { describeAnswer, scoreFree, type FreeAnswers, type FreeQuestion } from './freeScoring';
import {
  END_HREF,
  LEVELS,
  bandFor,
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
} from './freeTests';

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

export function FreeIntro({ set, onBegin }: { set: FreeSet; onBegin: () => void }): React.JSX.Element {
  const [best, setBest] = useState<BestScores>({});
  useEffect(() => setBest(readBest(set.exam)), [set.exam]);
  const exam = examOf(set);
  const total = itemsPerAttempt(set);
  return (
    <main style={{ ...WRAP, paddingTop: 48 }}>
      <Logo size={28} showWordmark href="/" />
      <p style={{ ...EYEBROW, marginTop: 40, marginBottom: 8 }}>
        <Link to={`/try/${set.exam}`} style={{ color: 'inherit' }}>
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
      <Card padding="lg">
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 'var(--aiq-text-lg)' }}>
          <li>A countdown timer runs. When it reaches zero your answers are submitted and scored.</li>
          <li>You see your score, a bar for each section, your weakest topic and an explanation for every question.</li>
          <li>This is practice only. It is not a real test score.</li>
        </ul>
      </Card>
      <p style={{ ...EYEBROW, margin: '24px 0 8px' }}>Your best score on this device</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-test-id="free-progress">
        {LEVELS.map((s) => (
          <Chip key={s} {...(s === set.slug ? { variant: 'accent' as const } : {})}>
            {exam.sets[s].title}: {best[s] != null ? `${best[s]}%` : 'not tried'}
          </Chip>
        ))}
      </div>
      <div style={{ marginTop: 24 }}>
        <Button size="lg" onClick={onBegin} data-test-id="try-begin">
          Start the {set.slug} test
        </Button>
      </div>
    </main>
  );
}

export function FreeResult({
  set,
  questions,
  answers,
  timedOut,
  usedSeconds,
  onRetry,
}: {
  set: FreeSet;
  questions: FreeQuestion[];
  answers: FreeAnswers;
  timedOut: boolean;
  usedSeconds: number;
  onRetry: () => void;
}): React.JSX.Element {
  const result = useMemo(() => scoreFree(answers, questions), [answers, questions]);
  const sections = useMemo(() => sectionScores(set, result.rows), [result]);
  const weakest = useMemo(() => weakestTopic(result.rows), [result]);
  const [best, setBest] = useState<BestScores>({});
  useEffect(() => setBest(saveBest(set.exam, set.slug, result.percent)), [set.exam, set.slug, result.percent]);

  const band = bandFor(result.percent);
  const flags = result.rows.map((r) => r.earned >= r.q.points);
  const text = shareText(set, flags, usedSeconds);
  const exam = examOf(set);
  const idx = LEVELS.indexOf(set.slug);
  const next = idx < LEVELS.length - 1 ? exam.sets[LEVELS[idx + 1]!] : null;
  const limit = set.minutes * 60;

  return (
    <main style={WRAP}>
      <Logo size={24} showWordmark href="/" />
      <p style={{ ...EYEBROW, marginTop: 32, marginBottom: 8 }}>Free {exam.title.toLowerCase()} test &middot; {set.slug} &middot; result</p>
      <h1 style={{ fontFamily: 'var(--aiq-font-serif)', fontWeight: 400, fontSize: 'var(--aiq-text-2xl)', margin: '0 0 8px' }}>
        {timedOut ? 'Time is up. Here is your score.' : 'Your score'}
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
            <p style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '8px 0 0' }}>
              Time {formatClock(usedSeconds)} of {formatClock(limit)}. {paceLine(result.percent, usedSeconds, limit)}
            </p>
            {best[set.slug] != null && (
              <p style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '4px 0 0' }}>
                Best on this device: {best[set.slug]}%
              </p>
            )}
          </div>
        </div>
      </Card>

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Sections</h2>
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

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Question breakdown</h2>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {result.rows.map(({ q, earned, answered }, i) => (
          <li key={q.id}>
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
              {q.why && <p style={{ margin: 0, fontSize: 13, color: 'var(--aiq-color-fg-muted)' }}>{q.why}</p>}
            </Card>
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: 18, fontWeight: 500, margin: '32px 0 12px' }}>Share</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <a href={whatsappLink(text)} target="_blank" rel="noopener noreferrer" style={LINK} data-test-id="free-whatsapp">
          Share on WhatsApp
        </a>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '32px 0 8px' }}>
        {next && (
          <Link to={`/try/${set.exam}/${next.slug}`} style={PRIMARY_LINK} data-test-id="free-next">
            Next: {next.title} test
          </Link>
        )}
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
        <Link to={`/try/${set.exam}`} style={LINK} data-test-id="free-levels">
          All levels
        </Link>
        <a href={END_HREF} style={next ? LINK : PRIMARY_LINK} data-test-id="free-end">
          Bring this to your batch
        </a>
      </div>
      <p style={{ fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '0 0 48px' }}>
        Practice only, not a real test score. Real assessments give fresh questions and saved progress.
      </p>
    </main>
  );
}
