// Public free test page: /try/:exam/:set (no RequireSession, no account). Pickers: FreePickers.tsx (/try, /try/:exam).
//
// The old demo runner was purged 2026-11-10 (owner). Never add a second runner: every public test uses FreeRunner,
// which reuses the real take-screen parts. Content comes from the registry (freeTests.ts).
//
// ZERO network requests (no api.ts, no fetch, no AI, no DB, no email). Attempt.tsx is deliberately not touched.

import { useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { FreeIntro, FreeResult } from './FreeScreens';
import { FreeRunner } from './FreeRunner';
import type { FreeAnswers, FreeQuestion } from './freeScoring';
import { drawSet, getExam, getSet, landingUrl, type FreeSet } from './freeTests';
import { useHead } from './useHead';

type Phase = 'intro' | 'run' | 'result';

export function TryPage(): React.JSX.Element {
  const { exam: examSlug, set: setSlug } = useParams();
  const exam = getExam(examSlug);
  if (!exam) return <Navigate to="/try" replace />;
  const set = getSet(exam, setSlug);
  if (!set) return <Navigate to={`/try/${exam.slug}`} replace />;
  // key: moving from one set to the next remounts the page with a fresh intro.
  return <TryFlow key={`${set.exam}/${set.slug}`} set={set} />;
}

function TryFlow({ set }: { set: FreeSet }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('intro');
  const [questions, setQuestions] = useState<FreeQuestion[]>([]);
  const [answers, setAnswers] = useState<FreeAnswers>({});
  const [endsAt, setEndsAt] = useState<string>('');
  const [startedAt, setStartedAt] = useState(0);
  const [usedSeconds, setUsedSeconds] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const examTitle = (getExam(set.exam)?.title ?? set.exam).toLowerCase();

  // A test points at its marketing landing page (Googlebot renders JS).
  useHead(`${set.title} ${examTitle} test, free | AssessIQ`, landingUrl(set));

  const begin = (): void => {
    setAnswers({});
    setTimedOut(false);
    setQuestions(drawSet(set));
    setStartedAt(Date.now());
    setEndsAt(new Date(Date.now() + set.minutes * 60_000).toISOString());
    setPhase('run');
  };

  const done = (byTimer: boolean): void => {
    setTimedOut(byTimer);
    setUsedSeconds(byTimer ? set.minutes * 60 : Math.min(set.minutes * 60, Math.round((Date.now() - startedAt) / 1000)));
    setPhase('result');
  };

  return (
    <div
      className="aiq-attempt-shell"
      style={{
        minHeight: '100vh',
        background: 'var(--aiq-color-bg-base)',
        color: 'var(--aiq-color-fg-primary)',
        fontFamily: 'var(--aiq-font-sans)',
        overflowX: 'hidden',
      }}
    >
      {phase === 'intro' && <FreeIntro set={set} onBegin={begin} />}
      {phase === 'run' && (
        <FreeRunner set={set} questions={questions} endsAt={endsAt} answers={answers} setAnswers={setAnswers} onFinish={done} />
      )}
      {phase === 'result' && (
        <FreeResult set={set} questions={questions} answers={answers} timedOut={timedOut} usedSeconds={usedSeconds} onRetry={begin} />
      )}
    </div>
  );
}
