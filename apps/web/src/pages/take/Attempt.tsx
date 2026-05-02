// Candidate attempt-taking page — Phase 1 G1.D
//
// Route: /take/attempt/:id  (registered in App.tsx by Opus)
//
// What this page does:
//   1. Fetch the attempt view on mount; render a loading screen while in flight.
//   2. On 401/403/404 → <Navigate to="/take/error" replace />.
//      On 5xx/network → IntegrityBanner stale_connection + Reload action.
//   3. On success → full attempt-taking surface (top bar, main pane, side panel,
//      bottom bar per the CSS-Grid layout in CONTRACT §LAYOUT).
//   4. Wire useAutosave: every answer change calls queueSave; blur calls flushSave.
//   5. Submit → submitAttempt → clearBackup → navigate to /take/attempt/:id/submitted.
//
// Anti-patterns explicitly refused (see contract):
//   - No dangerouslySetInnerHTML on question content.
//   - No localStorage for candidate session.
//   - No attempt_events rendered to the candidate.
//   - No --aiq-color-bg-elevated (renamed --aiq-color-bg-raised).
//   - No import from **/AccessIQ_UI_Template/** (ESLint forbids).
//   - No Monaco / KQL editor (Phase 2 deferred, decision #11).

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
} from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Button, Card, Chip, Icon, Logo } from '@assessiq/ui-system';
import {
  AttemptTimer,
  AutosaveIndicator,
  IntegrityBanner,
  QuestionNavigator,
  useAutosave,
  useIntegrityHooks,
  useMultiTabWarning,
  getAttempt,
  submitAttempt,
  toggleFlag,
  clearBackup,
  readBackup,
  CandidateApiError,
} from '@assessiq/candidate-ui';
import type {
  CandidateAttemptViewWire,
  FrozenQuestionWire,
  AttemptAnswerWire,
} from '@assessiq/candidate-ui';
import {
  HelpDrawer,
  HelpDrawerTrigger,
} from '@assessiq/help-system/components';

// ─── Types ───────────────────────────────────────────────────────────────────

type PageState =
  | { tag: 'loading' }
  | { tag: 'auth_error' }           // 401 / 403 / 404 → redirect
  | { tag: 'network_error' }        // 5xx / fetch failure → IntegrityBanner
  | { tag: 'ready'; view: CandidateAttemptViewWire };

// Narrowed content types for the answer area (FrozenQuestionWire.content is unknown)
interface McqOption {
  id: string;
  text: string;
}
interface McqContent {
  options: McqOption[];
}
interface SubjectiveContent {
  expected_word_count?: number;
}

// ─── Style constants ─────────────────────────────────────────────────────────

const TOP_BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--aiq-space-md)',
  height: 64,
  padding: '0 var(--aiq-space-2xl)',
  borderBottom: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
};

const BOTTOM_BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: 64,
  padding: '0 var(--aiq-space-2xl)',
  borderTop: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
  gap: 'var(--aiq-space-sm)',
};

const QUESTION_TEXT: CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  fontSize: 22,
  fontWeight: 400,
  lineHeight: 1.5,
  color: 'var(--aiq-color-fg-primary)',
  margin: '0 0 var(--aiq-space-xl)',
};

const COUNTER_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 12,
  color: 'var(--aiq-color-fg-muted)',
  whiteSpace: 'nowrap',
};

// ─── Answer area sub-components ───────────────────────────────────────────────

function McqAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: string) => void;
}): JSX.Element {
  const content = question.content as McqContent;
  const options: McqOption[] = Array.isArray(content?.options) ? content.options : [];
  const selectedId = typeof answer === 'string' ? answer : null;

  return (
    <div role="radiogroup" aria-label="Answer options" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}>
      {options.map((opt) => {
        const isSelected = opt.id === selectedId;
        return (
          <label
            key={opt.id}
            style={{ display: 'block', cursor: disabled ? 'not-allowed' : 'pointer' }}
          >
            {/* Hidden radio for a11y — Card is the visual affordance */}
            <input
              type="radio"
              name={question.question_id}
              value={opt.id}
              checked={isSelected}
              disabled={disabled}
              onChange={() => onAnswerChange(opt.id)}
              style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
            />
            <Card
              padding="sm"
              style={{
                border: isSelected
                  ? '2px solid var(--aiq-color-accent)'
                  : '1px solid var(--aiq-color-border)',
                background: isSelected
                  ? 'var(--aiq-color-accent-soft)'
                  : 'var(--aiq-color-bg-base)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'border-color 150ms ease, background 150ms ease',
                userSelect: 'none',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 15,
                  color: 'var(--aiq-color-fg-primary)',
                  lineHeight: 1.5,
                }}
              >
                {opt.text}
              </span>
            </Card>
          </label>
        );
      })}
    </div>
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

function SubjectiveAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: string) => void;
  onBlur: () => void;
}): JSX.Element {
  const content = question.content as SubjectiveContent | null;
  const expectedWordCount = content?.expected_word_count ?? null;
  const text = typeof answer === 'string' ? answer : '';
  const wordCount = countWords(text);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xs)' }}>
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => onAnswerChange(e.target.value)}
        onBlur={onBlur}
        aria-label="Your answer"
        style={{
          width: '100%',
          minHeight: 200,
          padding: 'var(--aiq-space-md)',
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 15,
          lineHeight: 1.6,
          color: 'var(--aiq-color-fg-primary)',
          background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-md)',
          resize: 'vertical',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
      <div
        style={{
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 11,
          color: 'var(--aiq-color-fg-muted)',
          textAlign: 'right',
        }}
      >
        {wordCount} / {expectedWordCount !== null ? expectedWordCount : '—'} words
      </div>
    </div>
  );
}

function KqlAnswerArea({
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: string) => void;
  onBlur: () => void;
}): JSX.Element {
  // TODO(phase-2): Monaco-based <KqlEditor> with KQL grammar — Phase 2 deferred
  // (decision #11 in PHASE_1_KICKOFF.md). Phase 1 uses a textarea.
  const text = typeof answer === 'string' ? answer : '';
  return (
    <textarea
      value={text}
      disabled={disabled}
      onChange={(e) => onAnswerChange(e.target.value)}
      onBlur={onBlur}
      aria-label="KQL query"
      style={{
        width: '100%',
        minHeight: 200,
        padding: 'var(--aiq-space-md)',
        fontFamily: 'var(--aiq-font-mono)',
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--aiq-color-fg-primary)',
        background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
        border: '1px solid var(--aiq-color-border)',
        borderRadius: 'var(--aiq-radius-md)',
        resize: 'vertical',
        boxSizing: 'border-box',
        outline: 'none',
      }}
    />
  );
}

function UnsupportedAnswerArea({ type }: { type: string }): JSX.Element {
  const isKnownDeferred = type === 'scenario' || type === 'log_analysis';
  return (
    <Card padding="md">
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 15,
          color: 'var(--aiq-color-fg-secondary)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {isKnownDeferred
          ? `${type === 'scenario' ? 'Scenario' : 'Log-analysis'} questions are not yet supported in this build. Skip and proceed.`
          : `Unsupported question type: ${type}`}
      </p>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AttemptPage(): JSX.Element {
  const { id: attemptId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // ── Page-level state ──────────────────────────────────────────────────────
  const [pageState, setPageState] = useState<PageState>({ tag: 'loading' });
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(null);
  // answers: Map<questionId, unknown> — source of truth for the current UI values.
  // Initialized from server's answers array after fetch; updated locally on every
  // candidate keystroke. The autosave hook writes these to the server + localStorage.
  const [answers, setAnswers] = useState<Map<string, unknown>>(new Map());
  // flags: Map<questionId, boolean>
  const [flags, setFlags] = useState<Map<string, boolean>>(new Map());
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Stable ref so callbacks can read the latest currentQuestionId without
  // re-creating and breaking memo/effect deps.
  const currentQuestionIdRef = useRef<string | null>(null);
  currentQuestionIdRef.current = currentQuestionId;

  // ── Fetch on mount ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!attemptId) {
      setPageState({ tag: 'auth_error' });
      return;
    }

    void (async () => {
      try {
        const view = await getAttempt(attemptId);

        // Seed local answer + flag maps from server state.
        const answerMap = new Map<string, unknown>();
        const flagMap = new Map<string, boolean>();
        for (const a of view.answers) {
          answerMap.set(a.question_id, a.answer);
          flagMap.set(a.question_id, a.flagged);
        }
        setAnswers(answerMap);
        setFlags(flagMap);

        // If the attempt is already terminal, lock immediately.
        if (view.attempt.status !== 'in_progress') {
          setLocked(true);
        }

        // Set the initial current question (first in position order).
        const sorted = [...view.questions].sort((a, b) => a.position - b.position);
        const first = sorted[0];
        if (first !== undefined && currentQuestionIdRef.current === null) {
          setCurrentQuestionId(first.question_id);
        }

        setPageState({ tag: 'ready', view });

        // LocalStorage backup check. Per contract: Phase 1 does NOT auto-restore
        // (too risky without UX confirmation). Phase 2 will add an explicit prompt.
        // Dev-only console.warn (gated to avoid noise in production where retry
        // storms can produce inflated local revisions vs server — see
        // modules/11-candidate-ui/RESILIENCE.md § Known cosmetic limitations).
        const backup = readBackup(attemptId);
        if (backup !== null && import.meta.env.DEV) {
          const maxServerRevision = view.answers.reduce(
            (max, a: AttemptAnswerWire) => Math.max(max, a.client_revision),
            0,
          );
          if (backup.clientRevision > maxServerRevision) {
            console.warn(
              '[AssessIQ] Local backup revision is newer than server' +
                ` (backup=${backup.clientRevision}, server=${maxServerRevision}).` +
                ' Phase 2 will surface a restore prompt.',
            );
          }
        }
      } catch (err) {
        if (err instanceof CandidateApiError) {
          const s = err.status;
          if (s === 401 || s === 403 || s === 404) {
            setPageState({ tag: 'auth_error' });
          } else {
            setPageState({ tag: 'network_error' });
          }
        } else {
          setPageState({ tag: 'network_error' });
        }
      }
    })();
    // Intentionally runs once on mount — attemptId is stable for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hooks (always called — args safe when not yet ready) ──────────────────

  const autosave = useAutosave({ attemptId, locked });

  useIntegrityHooks({
    attemptId,
    currentQuestionId,
    enabled: !locked,
  });

  const { multiTabActive } = useMultiTabWarning({ attemptId });

  // ── Timer expiry (stable via useCallback) ─────────────────────────────────

  const handleExpire = useCallback(() => {
    setLocked(true);
    // Server auto-submits past ends_at; a fresh getAttempt will confirm the
    // transition. Redirect to submitted view.
    void getAttempt(attemptId)
      .catch(() => {
        // Even if the re-fetch fails, the server has already auto-submitted.
        // Redirect anyway so the candidate doesn't sit on a locked blank page.
      })
      .finally(() => {
        navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
      });
  }, [attemptId, navigate]);

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm(
      'Submit your attempt? You cannot edit answers after this.',
    );
    if (!confirmed) return;

    setSubmitting(true);
    try {
      await submitAttempt(attemptId);
      clearBackup(attemptId);
      navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
    } catch (err) {
      // Surface submit failures — don't swallow silently.
      setSubmitting(false);
      const msg =
        err instanceof CandidateApiError
          ? err.apiError?.message ?? `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : 'Unknown error. Please try again.';
      window.alert(`Submit failed: ${msg}`);
    }
  }, [attemptId, navigate]);

  // ── Locked-redirect effect ────────────────────────────────────────────────
  // When locked becomes true (timer expire or terminal status on fetch), show a
  // 1.5 s notice then redirect.
  const lockedRedirectFired = useRef(false);
  useEffect(() => {
    if (!locked) return;
    if (lockedRedirectFired.current) return;
    lockedRedirectFired.current = true;
    const timer = setTimeout(() => {
      navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, [locked, attemptId, navigate]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render branches
  // ─────────────────────────────────────────────────────────────────────────

  // Loading
  if (pageState.tag === 'loading') {
    return (
      <div
        className="aiq-screen"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 12,
          color: 'var(--aiq-color-fg-muted)',
        }}
      >
        Loading attempt…
      </div>
    );
  }

  // Auth error → redirect
  if (pageState.tag === 'auth_error') {
    return <Navigate to="/take/error" replace />;
  }

  // Network / 5xx error
  if (pageState.tag === 'network_error') {
    return (
      <div
        className="aiq-screen"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--aiq-color-bg-base)',
          padding: 'var(--aiq-space-2xl)',
        }}
      >
        <div style={{ maxWidth: 560, width: '100%' }}>
          <IntegrityBanner
            kind="stale_connection"
            action={{
              label: 'Reload',
              onClick: () => window.location.reload(),
            }}
          />
        </div>
      </div>
    );
  }

  // ── Ready — full attempt surface ──────────────────────────────────────────

  const { view } = pageState;
  const { attempt, questions } = view;

  // Sort questions by position (ascending); this is the navigation order.
  const sorted: FrozenQuestionWire[] = [...questions].sort(
    (a, b) => a.position - b.position,
  );

  const currentIdx = currentQuestionId !== null
    ? sorted.findIndex((q) => q.question_id === currentQuestionId)
    : 0;
  const safeIdx = currentIdx < 0 ? 0 : currentIdx;
  const currentQuestion = sorted[safeIdx] ?? null;
  const isFirst = safeIdx === 0;
  const isLast = safeIdx === sorted.length - 1;

  // Derive topic from the first question for the header chip.
  const topicLabel = sorted[0]?.topic ?? '';

  // ── Answer change handler ─────────────────────────────────────────────────
  function handleAnswerChange(value: unknown): void {
    if (!currentQuestion || locked) return;
    const qid = currentQuestion.question_id;
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(qid, value);
      return next;
    });
    autosave.queueSave(qid, value);
  }

  function handleAnswerBlur(): void {
    if (!currentQuestion || locked) return;
    void autosave.flushSave(currentQuestion.question_id);
  }

  // ── Flag toggle ───────────────────────────────────────────────────────────
  function handleFlagToggle(): void {
    if (!currentQuestion || locked) return;
    const qid = currentQuestion.question_id;
    const currentFlag = flags.get(qid) ?? false;
    const nextFlag = !currentFlag;
    // Optimistic local update
    setFlags((prev) => {
      const next = new Map(prev);
      next.set(qid, nextFlag);
      return next;
    });
    // Fire-and-forget: server is authoritative; local state reflects intent
    toggleFlag(attemptId, qid, nextFlag).catch(() => {
      // Roll back on failure
      setFlags((prev) => {
        const next = new Map(prev);
        next.set(qid, currentFlag);
        return next;
      });
    });
  }

  // ── Navigator items ───────────────────────────────────────────────────────
  const navigatorItems = sorted.map((q) => {
    const qid = q.question_id;
    const isCurrentQ = qid === currentQuestionId;
    const isFlagged = flags.get(qid) ?? false;
    const ans = answers.get(qid);
    const isAnswered = ans !== null && ans !== undefined && ans !== '';

    let status: 'unanswered' | 'answered' | 'flagged' | 'current';
    if (isCurrentQ) {
      status = 'current';
    } else if (isFlagged) {
      status = 'flagged';
    } else if (isAnswered) {
      status = 'answered';
    } else {
      status = 'unanswered';
    }

    return { questionId: qid, position: q.position, status };
  });

  // ── Locked banner ─────────────────────────────────────────────────────────
  const lockedBanner = locked ? (
    <div
      style={{
        padding: 'var(--aiq-space-sm) var(--aiq-space-2xl)',
        background: 'oklch(0.97 0.05 70)',
        borderBottom: '1px solid var(--aiq-color-warning)',
        fontFamily: 'var(--aiq-font-sans)',
        fontSize: 14,
        color: 'var(--aiq-color-fg-primary)',
        textAlign: 'center',
      }}
    >
      Attempt is now locked. Redirecting…
    </div>
  ) : null;

  // ── Outer grid ────────────────────────────────────────────────────────────
  return (
    <div
      className="aiq-screen"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        minHeight: '100vh',
        background: 'var(--aiq-color-bg-base)',
      }}
    >
      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <header style={TOP_BAR}>
        <Logo />

        {topicLabel && (
          <Chip variant="default" style={{ flexShrink: 0 }}>
            {topicLabel}
          </Chip>
        )}

        <span style={{ ...COUNTER_LABEL, flex: 1 }}>
          Question {safeIdx + 1} of {sorted.length}
        </span>

        {attempt.ends_at !== null && (
          <AttemptTimer
            endsAt={attempt.ends_at}
            onExpire={handleExpire}
          />
        )}

        <AutosaveIndicator
          status={autosave.status}
          lastSavedAt={autosave.lastSavedAt}
          retryCount={autosave.retryCount}
        />

        <HelpDrawerTrigger />
      </header>

      {lockedBanner}

      {/* ── MIDDLE ROW (main pane + side panel) ─────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          gap: 'var(--aiq-space-xl)',
          padding: 'var(--aiq-space-lg) var(--aiq-space-2xl)',
          overflow: 'auto',
        }}
      >
        {/* Main pane */}
        <main style={{ minWidth: 0 }}>
          {/* Multi-tab warning */}
          {multiTabActive && (
            <div style={{ marginBottom: 'var(--aiq-space-md)' }}>
              <IntegrityBanner kind="multi_tab" />
            </div>
          )}

          {currentQuestion !== null ? (
            <>
              {/* Question text */}
              <p className="aiq-serif" style={QUESTION_TEXT}>
                {typeof (currentQuestion.content as Record<string, unknown>)?.stem === 'string'
                  ? (currentQuestion.content as Record<string, unknown>).stem as string
                  : typeof currentQuestion.content === 'string'
                    ? currentQuestion.content
                    : `Question ${currentQuestion.position}`}
              </p>

              {/* Type-switched answer area */}
              <AnswerArea
                question={currentQuestion}
                answer={answers.get(currentQuestion.question_id) ?? null}
                disabled={locked}
                onAnswerChange={handleAnswerChange}
                onBlur={handleAnswerBlur}
              />
            </>
          ) : (
            <p style={{ color: 'var(--aiq-color-fg-muted)', fontFamily: 'var(--aiq-font-sans)' }}>
              No questions available.
            </p>
          )}
        </main>

        {/* Side panel */}
        <aside
          style={{
            borderLeft: '1px solid var(--aiq-color-border)',
            paddingLeft: 'var(--aiq-space-md)',
          }}
        >
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
            Questions
          </div>
          <QuestionNavigator
            items={navigatorItems}
            onSelect={(qid) => {
              setCurrentQuestionId(qid);
              // Navigator click does NOT flush; debounced autosave handles it.
            }}
          />
        </aside>
      </div>

      {/* ── BOTTOM BAR ──────────────────────────────────────────────────── */}
      <footer style={BOTTOM_BAR}>
        {/* Flag toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleFlagToggle}
          disabled={locked || currentQuestion === null}
          style={{
            color:
              currentQuestion !== null && (flags.get(currentQuestion.question_id) ?? false)
                ? 'var(--aiq-color-warning)'
                : 'var(--aiq-color-fg-secondary)',
          }}
        >
          <Icon name="flag" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
          {currentQuestion !== null && (flags.get(currentQuestion.question_id) ?? false)
            ? 'Flagged'
            : 'Flag'}
        </Button>

        {/* Spacer */}
        <span style={{ flex: 1 }} />

        {/* Prev */}
        <Button
          variant="outline"
          size="sm"
          disabled={isFirst || locked}
          onClick={() => {
            const prev = sorted[safeIdx - 1];
            if (prev !== undefined) {
              setCurrentQuestionId(prev.question_id);
            }
          }}
        >
          <Icon name="arrowLeft" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
          Prev
        </Button>

        {/* Next (hidden on last question, but Next + Submit are BOTH always shown) */}
        {!isLast && (
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => {
              const next = sorted[safeIdx + 1];
              if (next !== undefined) {
                setCurrentQuestionId(next.question_id);
              }
            }}
          >
            Next
            <Icon name="arrow" size={14} style={{ marginLeft: 'var(--aiq-space-2xs)' }} />
          </Button>
        )}

        {/* Submit — always visible; enabled even if not all questions answered
            (Phase 1 uses window.confirm guard per contract decision) */}
        <Button
          variant="primary"
          size="sm"
          disabled={locked || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </Button>
      </footer>

      {/* Help drawer — degrades gracefully if HelpProvider is not mounted above */}
      <HelpDrawer />
    </div>
  );
}

// ─── AnswerArea dispatcher ────────────────────────────────────────────────────
// Extracted to a named component so React's reconciler never loses the element
// tree when the question type changes (different sub-components but same slot).

function AnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  switch (question.type) {
    case 'mcq':
      return (
        <McqAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
        />
      );

    case 'subjective':
      return (
        <SubjectiveAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    case 'kql':
      return (
        <KqlAnswerArea
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    case 'scenario':
    case 'log_analysis':
    default:
      return <UnsupportedAnswerArea type={question.type} />;
  }
}
