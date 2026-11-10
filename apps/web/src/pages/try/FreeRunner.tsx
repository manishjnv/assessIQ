// Free no-login test runner (/try/:exam/:set), the ONLY test runner of the public pages.
//
// Same screen as the real take page (Attempt.tsx): top bar, progress row, left navigator panel (rail on
// collapse, strip + bottom sheet on mobile), question card, flag, Prev/Next, "Finish assessment" in the top
// bar, the "Review & finish" summary and the submit dialog. It reuses the real parts in take/attempt-parts
// and fills them from local in-memory state. ZERO network: no getAttempt, autosave, position call, flag call,
// integrity hooks, fullscreen gate, camera, tab warning or report-a-problem. Attempt.tsx is not touched.
//
// Copied from Attempt.tsx on purpose (they call the API there): the filter-aware Prev/Next targets and the
// footer. Everything else is imported.

import { useState } from 'react';
import { Button, Chip, Drawer, Icon } from '@assessiq/ui-system';
import { NavCollapseHandle, filterSuffix, neighbor } from '@assessiq/candidate-ui';
import type { AttemptWire, FrozenQuestionWire, NavigatorFilter, UseAutosaveResult } from '@assessiq/candidate-ui';
import { AnswerArea } from '../take/attempt-parts/AnswerArea';
import { AttemptTopBar } from '../take/attempt-parts/AttemptTopBar';
import { FinishSummary } from '../take/attempt-parts/FinishSummary';
import { KeyNav, KeyShortcutsToggle, useKeyShortcuts } from '../take/attempt-parts/KeyNav';
import { NavigatorBody } from '../take/attempt-parts/NavigatorBody';
import { ProgressRow } from '../take/attempt-parts/ProgressRow';
import { BOTTOM_BAR, KBD_HINT, SR_ONLY, TYPE_LABEL, isAnsweredValue } from '../take/attempt-parts/shared';
import { SubmitConfirmModal } from '../take/attempt-parts/SubmitConfirmModal';
import { useTakePrefs } from '../take/attempt-parts/takePrefs';
import { useMaxWidth } from '../take/attempt-parts/useMaxWidth';
import { RichText } from '../take/rich-parts';
import '../take/take-theme.css';
import type { FreeAnswers, FreeQuestion } from './freeScoring';
import { getExam, type FreeSet } from './freeTests';

// The top bar wants the autosave hook's shape; a free test saves nothing, so it gets an idle stub.
const NO_AUTOSAVE: UseAutosaveResult = {
  status: 'idle',
  lastSavedAt: null,
  retryCount: 0,
  queueSave: () => undefined,
  flushSave: () => Promise.resolve(),
  stopQuestion: () => undefined,
};


export function FreeRunner({
  set,
  questions,
  endsAt,
  answers,
  setAnswers,
  onFinish,
}: {
  set: FreeSet;
  questions: FreeQuestion[];
  endsAt: string;
  answers: FreeAnswers;
  setAnswers: (fn: (prev: FreeAnswers) => FreeAnswers) => void;
  onFinish: (byTimer: boolean) => void;
}): React.JSX.Element {
  const [currentId, setCurrentId] = useState(questions[0]!.id);
  const [flags, setFlags] = useState<Set<string>>(new Set());
  const [navFilter, setNavFilter] = useState<NavigatorFilter>('all');
  const [navOpen, setNavOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearNonce, setClearNonce] = useState(0);
  const [keysOn, setKeysOn] = useKeyShortcuts();
  const [prefs, setPrefs] = useTakePrefs();
  const stripMode = useMaxWidth(900);
  const examTitle = getExam(set.exam)?.title.toLowerCase() ?? set.exam;
  const sectionIndex = (q: FreeQuestion): number => Math.max(0, set.sections.findIndex((x) => x.id === q.section));

  // FreeQuestion -> the wire shape the real parts read.
  const sorted: FrozenQuestionWire[] = questions.map((q, i) => ({
    question_id: q.id,
    position: i + 1,
    question_version: 1,
    type: 'mcq',
    topic: q.topic ?? '',
    points: q.points,
    answer_guidance: '',
    content: { question: q.prompt, options: q.options ?? [] },
    section_index: sectionIndex(q),
  }));
  const sectionNames = set.sections.map((s) => s.label);
  const attempt: AttemptWire = {
    id: `free-${set.exam}-${set.slug}`,
    tenant_id: '',
    assessment_id: `free-${set.exam}-${set.slug}`,
    user_id: 'free',
    status: 'in_progress',
    started_at: null,
    ends_at: endsAt,
    submitted_at: null,
    duration_seconds: set.minutes * 60,
    created_at: '',
  };

  const wireAnswer = (id: string): unknown => {
    const a = answers[id];
    return typeof a === 'number' ? { selected: a } : null;
  };
  const idx = Math.max(0, sorted.findIndex((q) => q.question_id === currentId));
  const current = sorted[idx]!;
  const isLast = idx === sorted.length - 1;

  const navigatorItems = sorted.map((q) => {
    const answered = isAnsweredValue(wireAnswer(q.question_id));
    const flagged = flags.has(q.question_id);
    const status = q.question_id === currentId ? 'current' : flagged ? 'flagged' : answered ? 'answered' : 'unanswered';
    const si = q.section_index ?? 0;
    return { questionId: q.question_id, position: q.position, status, answered, flagged, section: { index: si, name: sectionNames[si]! } } as const;
  });
  const answeredCount = navigatorItems.filter((it) => it.answered).length;
  const totalCount = sorted.length;
  const unansweredCount = totalCount - answeredCount;
  const flaggedCount = flags.size;

  const setAnswer = (value: unknown): void => {
    const sel = (value as { selected?: unknown } | null)?.selected;
    setAnswers((prev) => ({ ...prev, [current.question_id]: typeof sel === 'number' ? sel : null }));
  };
  const toggleFlag = (): void =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (!next.delete(current.question_id)) next.add(current.question_id);
      return next;
    });
  const handlePick = (i: number): void => {
    if (i < (questions[idx]!.options?.length ?? 0)) setAnswer({ selected: i });
  };

  // Same Prev/Next rule as Attempt.tsx (Z-169): a filter jumps to the next match; no match steps by one.
  const filterPrev = neighbor(navigatorItems, currentId, -1, navFilter);
  const filterNext = neighbor(navigatorItems, currentId, 1, navFilter);
  const prevPlain = navFilter !== 'all' && filterPrev === null;
  const nextPlain = navFilter !== 'all' && filterNext === null;
  const prevTarget = prevPlain ? neighbor(navigatorItems, currentId, -1, 'all') : filterPrev;
  const nextTarget = nextPlain ? neighbor(navigatorItems, currentId, 1, 'all') : filterNext;
  const goPrev = (): void => {
    if (prevTarget !== null) setCurrentId(prevTarget.questionId);
  };
  const goNext = (): void => {
    if (isLast) setSummaryOpen(true);
    else if (nextTarget !== null) setCurrentId(nextTarget.questionId);
  };
  const toggleNav = (): void => setPrefs({ navCollapsed: !prefs.navCollapsed });

  const navProps = { navigatorItems, setCurrentQuestionId: setCurrentId, setNavOpen, filter: navFilter, onFilterChange: setNavFilter };
  const stem = (current.content as { question: string }).question;

  return (
    <div
      className="aiq-screen aiq-attempt-shell aiq-take-root"
      data-take-theme={prefs.theme}
      style={{ display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr) auto', height: '100dvh', background: 'var(--aiq-color-bg-base)' }}
    >
      <AttemptTopBar
        sec={undefined}
        wholeTestSectionName={sectionNames[current.section_index ?? 0]}
        attempt={attempt}
        safeIdx={idx}
        questionCount={totalCount}
        isLastSection
        handleExpire={() => onFinish(true)}
        refreshAfterSectionChange={() => Promise.resolve()}
        autosave={NO_AUTOSAVE}
        setNavOpen={setNavOpen}
        prefs={prefs}
        setPrefs={setPrefs}
        candidateName="You"
        candidateId="free"
        assessmentName={`${set.title} ${examTitle} test`}
        logoHref="/"
        assessmentId={attempt.assessment_id}
        onFinish={summaryOpen ? undefined : () => setSummaryOpen(true)}
        badge={<Chip variant="warn">Practice</Chip>}
      />

      <section aria-label="Progress">
        <ProgressRow items={navigatorItems} safeIdx={idx} answeredCount={answeredCount} onJump={setCurrentId} />
      </section>

      {summaryOpen ? (
        <FinishSummary
          rows={sorted.map((q) => ({ q, position: q.position, answer: wireAnswer(q.question_id), flagged: flags.has(q.question_id) }))}
          answered={answeredCount}
          total={totalCount}
          flagged={flaggedCount}
          endsAt={endsAt}
          onOpen={(qid) => {
            setSummaryOpen(false);
            setCurrentId(qid);
          }}
          onBack={() => setSummaryOpen(false)}
          onSubmit={() => setConfirmOpen(true)}
          submitting={false}
        />
      ) : (
        <div className="aiq-attempt-middle" data-nav-collapsed={prefs.navCollapsed ? 'true' : undefined} style={{ display: 'grid', overflow: 'hidden' }}>
          <main className="aiq-attempt-main" style={{ minWidth: 0 }}>
            <h1 style={SR_ONLY}>{set.title} {examTitle} test</h1>
            <div className="aiq-take-stage" key={current.question_id} data-has-passage="false">
              <div className="aiq-take-qpane" style={{ minWidth: 0 }}>
                <div className="aiq-take-qhead">
                  <span className="aiq-take-type-chip">{TYPE_LABEL['mcq']}</span>
                  <button
                    type="button"
                    className="aiq-take-flag aiq-attempt-flag-btn"
                    aria-pressed={flags.has(current.question_id)}
                    onClick={toggleFlag}
                    aria-keyshortcuts="F"
                  >
                    <Icon name="flag" size={14} />
                    {flags.has(current.question_id) ? 'Flagged' : 'Flag for review'}
                  </button>
                </div>
                <p className="aiq-serif aiq-attempt-q-text">
                  <RichText q={current} text={stem} />
                </p>
                <AnswerArea
                  key={`${current.question_id}:${clearNonce}`}
                  question={current}
                  answer={wireAnswer(current.question_id)}
                  disabled={false}
                  onAnswerChange={setAnswer}
                  onBlur={() => undefined}
                />
              </div>
            </div>
          </main>
          <aside className="aiq-attempt-aside" style={{ borderLeft: '1px solid var(--aiq-color-border)', background: 'var(--aiq-color-bg-raised)' }}>
            <NavCollapseHandle collapsed={prefs.navCollapsed} onToggle={toggleNav} />
            <div
              className="aiq-attempt-aside-scroll"
              style={{ padding: 'var(--aiq-space-lg) var(--aiq-space-md)' }}
            >
              {!prefs.navCollapsed && (
                <div
                  style={{
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--aiq-color-fg-muted)',
                    marginBottom: 'var(--aiq-space-sm)',
                    paddingLeft: 'var(--aiq-space-md)',
                  }}
                >
                  Navigator
                </div>
              )}
              <NavigatorBody {...navProps} collapsed={prefs.navCollapsed} />
            </div>
          </aside>
          {stripMode && (
            <div className="aiq-attempt-strip">
              <NavigatorBody
                {...navProps}
                layout="strip"
                trailing={
                  <button type="button" className="aiq-qnav-btn aiq-take-strip-grid" aria-label="Open all questions" aria-haspopup="dialog" onClick={() => setNavOpen(true)}>
                    <Icon name="grid" size={18} />
                  </button>
                }
              />
            </div>
          )}
        </div>
      )}

      <style>{'[data-viewport="mobile"] .aiq-attempt-kbd{display:none}'}</style>
      <KeyNav onPrev={goPrev} onNext={goNext} onPick={handlePick} onFlag={toggleFlag} onToggleNav={toggleNav} enabled={keysOn} disabled={confirmOpen || navOpen || summaryOpen} />

      {!summaryOpen && (
        <footer className="aiq-attempt-bottom" style={BOTTOM_BAR}>
          <Button
            variant="ghost"
            size="sm"
            className="aiq-attempt-clear-btn"
            onClick={() => {
              setAnswer(null);
              setClearNonce((n) => n + 1);
            }}
            disabled={!isAnsweredValue(wireAnswer(current.question_id))}
            style={{ color: 'var(--aiq-color-fg-secondary)' }}
          >
            Clear response
          </Button>
          {navFilter !== 'all' && (
            <button type="button" className="aiq-take-filter-pill" data-filter={navFilter} onClick={() => setNavFilter('all')}>
              {navFilter.toUpperCase()} ONLY · {navFilter === 'flagged' ? flaggedCount : navFilter === 'answered' ? answeredCount : unansweredCount}
              <span aria-hidden="true"> ×</span>
              <span style={SR_ONLY}> Clear filter</span>
            </button>
          )}
          <span className="aiq-attempt-spacer" style={{ flex: 1 }} />
          <span className="aiq-attempt-kbd">
            <KeyShortcutsToggle on={keysOn} onChange={setKeysOn} />
          </span>
          <Button variant="primary" size="lg" className="aiq-attempt-prev-btn" disabled={prevTarget === null} aria-keyshortcuts="P" onClick={goPrev}>
            <Icon name="arrowLeft" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
            Prev{prevPlain ? '' : filterSuffix(navFilter)}
            <kbd className="aiq-attempt-kbd" aria-hidden="true" style={KBD_HINT}>P</kbd>
          </Button>
          {isLast ? (
            <Button variant="primary" size="lg" className="aiq-attempt-next-btn" onClick={() => setSummaryOpen(true)}>
              Review &amp; finish
              <Icon name="arrow" size={14} style={{ marginLeft: 'var(--aiq-space-2xs)' }} />
            </Button>
          ) : (
            <Button variant="primary" size="lg" className="aiq-attempt-next-btn" disabled={nextTarget === null} aria-keyshortcuts="N" onClick={goNext}>
              Next{nextPlain ? '' : filterSuffix(navFilter)}
              <Icon name="arrow" size={14} style={{ marginLeft: 'var(--aiq-space-2xs)' }} />
              <kbd className="aiq-attempt-kbd" aria-hidden="true" style={KBD_HINT}>N</kbd>
            </Button>
          )}
        </footer>
      )}

      <SubmitConfirmModal
        confirmOpen={confirmOpen}
        submitting={false}
        submitError={null}
        setConfirmOpen={setConfirmOpen}
        sectionLines={[]}
        answeredCount={answeredCount}
        totalCount={totalCount}
        overallUnanswered={unansweredCount}
        flaggedCount={flaggedCount}
        handleSubmit={() => {
          onFinish(false);
          return Promise.resolve();
        }}
      />

      <Drawer open={navOpen} onClose={() => setNavOpen(false)} title="Navigator" placement={stripMode ? 'bottom' : 'right'}>
        <NavigatorBody {...navProps} />
      </Drawer>
    </div>
  );
}
