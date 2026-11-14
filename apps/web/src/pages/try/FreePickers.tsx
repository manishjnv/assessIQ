// The two pick screens before a free test: /try (choose the exam) and /try/:exam (choose the level).
// In-browser only: no network. The cards come from the registry (freeTests.ts); only real exams are listed.

import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { Card, Chip, Logo } from '@assessiq/ui-system';
import { CRUMB, EYEBROW, H1, WRAP } from './FreeScreens';
import { EXAM_SLUGS, FREE_EXAMS, LEVELS, getExam, bestLine, itemsPerAttempt, readBest, type BestScores } from './freeTests';
import { useHead } from './useHead';

const PAGE: React.CSSProperties = {
  minHeight: '100vh',
  background: 'var(--aiq-color-bg-base)',
  color: 'var(--aiq-color-fg-primary)',
  fontFamily: 'var(--aiq-font-sans)',
  overflowX: 'hidden',
};
const CARD_LINK: React.CSSProperties = { display: 'block', color: 'inherit', textDecoration: 'none' };
const GRID: React.CSSProperties = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' };
const LEAD: React.CSSProperties = { fontSize: 'var(--aiq-text-lg)', lineHeight: 1.55, color: 'var(--aiq-color-fg-secondary)', margin: '0 0 24px' };
const CARD_TITLE: React.CSSProperties = { fontFamily: 'var(--aiq-font-serif)', fontWeight: 400, fontSize: 'var(--aiq-text-2xl)', margin: '8px 0' };
const META: React.CSSProperties = { fontSize: 13, color: 'var(--aiq-color-fg-muted)', margin: '4px 0 0' };

const TRY_URL = 'https://assessiq.in/try';

export function ExamPickerPage(): React.JSX.Element {
  useHead('Free tests, no login | AssessIQ', TRY_URL);
  return (
    <div className="aiq-attempt-shell" style={PAGE}>
      <main style={{ ...WRAP, paddingTop: 48 }}>
        <Logo size={28} showWordmark href="/" />
        <p style={{ ...EYEBROW, marginTop: 40, marginBottom: 8 }}>Free tests</p>
        <h1 style={H1}>Take a free test.</h1>
        <p style={LEAD}>Pick an exam, then a level. No login and no email. Your answers stay in your browser.</p>
        <div style={GRID} data-test-id="free-exams">
          {EXAM_SLUGS.map((slug) => {
            const exam = FREE_EXAMS[slug]!;
            return (
              <Link key={slug} to={`/try/${slug}`} style={CARD_LINK} data-test-id={`free-exam-${slug}`}>
                <Card padding="lg">
                  <h2 style={CARD_TITLE}>{exam.title}</h2>
                  <p style={{ ...LEAD, margin: 0, fontSize: 14 }}>{exam.blurb}</p>
                </Card>
              </Link>
            );
          })}
        </div>
        <p style={{ ...META, marginTop: 24 }}>More exams are coming.</p>
      </main>
    </div>
  );
}

export function LevelPickerPage(): React.JSX.Element {
  const { exam: slug } = useParams();
  const exam = getExam(slug);
  const [best, setBest] = useState<BestScores>({});
  useEffect(() => {
    if (exam) setBest(readBest(exam.slug));
  }, [exam]);
  useHead(
    exam ? `Free ${exam.title.toLowerCase()} tests, no login | AssessIQ` : 'Free tests, no login | AssessIQ',
    TRY_URL,
  );
  if (!exam) return <Navigate to="/try" replace />;
  return (
    <div className="aiq-attempt-shell" style={PAGE}>
      <main style={{ ...WRAP, paddingTop: 48 }}>
        <Logo size={28} showWordmark href="/" />
        <p style={{ ...EYEBROW, marginTop: 40, marginBottom: 8 }}>
          <Link to="/try" style={CRUMB}>
            Free tests
          </Link>{' '}
          &middot; {exam.title}
        </p>
        <h1 style={H1}>Free {exam.title.toLowerCase()} test: pick a level.</h1>
        <p style={LEAD}>{exam.blurb}</p>
        <div style={GRID} data-test-id="free-levels">
          {LEVELS.map((l) => {
            const set = exam.sets[l];
            return (
              <Link key={l} to={`/try/${exam.slug}/${l}`} style={CARD_LINK} data-test-id={`free-level-${l}`}>
                <Card padding="lg">
                  <p style={EYEBROW}>{l}</p>
                  <h2 style={CARD_TITLE}>{set.title}</h2>
                  <p style={META}>
                    {itemsPerAttempt(set)} questions, {set.minutes} minutes
                  </p>
                  <p style={{ margin: '12px 0 0' }}>
                    <Chip {...(bestLine(best[l]) != null ? { variant: 'success' as const } : {})}>
                      {bestLine(best[l]) != null ? `Best on this device: ${bestLine(best[l])}` : 'Not tried'}
                    </Chip>
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
