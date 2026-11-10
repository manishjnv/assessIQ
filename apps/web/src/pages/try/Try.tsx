// Public free test page: /try/:exam/:set (no RequireSession, no account). Pickers: FreePickers.tsx (/try, /try/:exam).
//
// The old demo runner was purged 2026-11-10 (owner). Never add a second runner: every public test uses FreeRunner,
// which reuses the real take-screen parts. Content comes from the registry (freeTests.ts).
//
// Mode (Mock or Real) comes from ?mode= (default Mock) and is frozen when the test starts. Real adds only the local
// useFreeRealMode hook: never the real integrity hooks (they call the API).
//
// ZERO network requests (no api.ts, no fetch, no AI, no DB, no email). Attempt.tsx is deliberately not touched.

import { useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { IntegrityBanner } from '@assessiq/candidate-ui';
import { FreeIntro, FreeResult } from './FreeScreens';
import { FreeRunner } from './FreeRunner';
import type { FreeAnswers, FreeQuestion } from './freeScoring';
import { ALL_MODES, drawAndRemember, getExam, getSet, landingUrl, parseMode, type FreeSet, type Mode } from './freeTests';
import { useFreeRealMode } from './useFreeRealMode';
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
  const exam = getExam(set.exam)!;
  const examTitle = exam.title.toLowerCase();
  const [sp, setSp] = useSearchParams();
  const urlMode = parseMode(sp.get('mode'), exam.modes ?? ALL_MODES);
  const [runMode, setRunMode] = useState<Mode>(urlMode);
  const real = useFreeRealMode(runMode === 'real' && phase === 'run');

  // A test points at its marketing landing page (Googlebot renders JS).
  useHead(`${set.title} ${examTitle} test, free | AssessIQ`, landingUrl(set));

  const begin = (mode: Mode): void => {
    setRunMode(mode);
    if (mode === 'real') real.start();
    setAnswers({});
    setTimedOut(false);
    setQuestions(drawAndRemember(set));
    setStartedAt(Date.now());
    setEndsAt(new Date(Date.now() + set.minutes * 60_000).toISOString());
    setPhase('run');
  };

  const done = (byTimer: boolean): void => {
    setTimedOut(byTimer);
    setUsedSeconds(byTimer ? set.minutes * 60 : Math.min(set.minutes * 60, Math.round((Date.now() - startedAt) / 1000)));
    setPhase('result');
  };

  const tryReal = (): void => {
    setSp({ mode: 'real' }, { replace: true });
    setPhase('intro');
  };

  const banner =
    runMode === 'real' ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 16px 0' }}>
        {real.note && <IntegrityBanner kind="tab_was_blurred" message={real.note} />}
        {real.leaves > 0 && (
          <IntegrityBanner
            kind="tab_was_blurred"
            message={`You left the test ${real.leaves} ${real.leaves === 1 ? 'time' : 'times'}. Nothing is recorded here. In a real assessment the organisation sees this.`}
          />
        )}
        {real.leftFullscreen && (
          <IntegrityBanner kind="tab_was_blurred" message="You left full screen." action={{ label: 'Return to full screen', onClick: real.returnToFullscreen }} />
        )}
      </div>
    ) : undefined;

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
      {phase === 'intro' && (
        <FreeIntro
          set={set}
          mode={urlMode}
          onMode={(m) => setSp({ mode: m }, { replace: true })}
          onBegin={() => begin(urlMode)}
        />
      )}
      {phase === 'run' && (
        <FreeRunner set={set} mode={runMode} banner={banner} questions={questions} endsAt={endsAt} answers={answers} setAnswers={setAnswers} onFinish={done} />
      )}
      {phase === 'result' && (
        <FreeResult
          set={set}
          mode={runMode}
          questions={questions}
          answers={answers}
          timedOut={timedOut}
          usedSeconds={usedSeconds}
          onRetry={() => begin(runMode)}
          onTryReal={tryReal}
        />
      )}
    </div>
  );
}
