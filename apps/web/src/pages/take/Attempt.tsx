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
//   5. Submit → submitAttempt → clearBackup → navigate to /take/attempt/:id/submitted
//      (the submit response rides along as router state — see Submitted.tsx).
//
// Anti-patterns explicitly refused (see contract):
//   - No dangerouslySetInnerHTML on question content.
//   - No localStorage for candidate session.
//   - No attempt_events rendered to the candidate.
//   - No --aiq-color-bg-elevated (renamed --aiq-color-bg-raised).
//   - No import from **/AssessIQ_UI_Template/** (ESLint forbids).
//   - No Monaco / KQL editor (Phase 2 deferred, decision #11).

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
} from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Button, Card, Chip, Drawer, Icon, Logo, Modal, Spinner } from '@assessiq/ui-system';
import {
  AttemptTimer,
  Calculator,
  AutosaveIndicator,
  IntegrityBanner,
  FullscreenGate,
  QuestionNavigator,
  useAutosave,
  useIntegrityHooks,
  useMultiTabWarning,
  getAttempt,
  submitAttempt,
  finishSection,
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
import { CandidateHelp } from '@assessiq/candidate-ui';
import { isQuestionType } from '@assessiq/question-types';
import { rendererMap, type QuestionRenderer } from './renderers.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type PageState =
  | { tag: 'loading' }
  | { tag: 'auth_error' }           // 401 / 403 / 404 → redirect
  | { tag: 'network_error' }        // 5xx / fetch failure → IntegrityBanner
  | { tag: 'ready'; view: CandidateAttemptViewWire };

// ─── Canonical content types (Stage 1.5d shape lock) ──────────────────────────
//
// Field names are locked to the sharded-generation output.
// Any question whose content contains a FORBIDDEN SYNONYM key must render
// <MalformedQuestion> — no partial render of legacy DB rows.
const FORBIDDEN_SYNONYM_KEYS: ReadonlySet<string> = new Set([
  'stem', 'explanation', 'log_snippet', 'answer_key', 'task', 'correct_answer',
]);

function hasForbiddenSynonym(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) return false;
  return Object.keys(content as object).some((k) => FORBIDDEN_SYNONYM_KEYS.has(k));
}


// ─── Style constants ─────────────────────────────────────────────────────────

const TOP_BAR: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--aiq-space-md)',
  // height + padding moved to .aiq-attempt-top class — viewport-aware (M2a).
  borderBottom: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
};

const BOTTOM_BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // height + padding moved to .aiq-attempt-bottom class — viewport-aware (M2a).
  borderTop: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
  gap: 'var(--aiq-space-sm)',
};

const QUESTION_TEXT: CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  // font-size moved to .aiq-attempt-q-text class — viewport-aware (M2a).
  // Desktop 30px (var(--aiq-text-2xl)) / mobile 22px via the scoped
  // --aiq-attempt-q-size CSS var defined on .aiq-attempt-shell.
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


/** Shown when question content contains a forbidden synonym key (Stage 1.5d shape lock). */
function MalformedQuestion(): React.JSX.Element {
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
        This question content is malformed — contact your administrator.
      </p>
    </Card>
  );
}

/** Shown for any type string not in the known set (future-proofing). */
function UnknownTypeArea({ type }: { type: string }): React.JSX.Element {
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
        Unsupported question type: {type}
      </p>
    </Card>
  );
}


// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Single "is this question answered?" predicate, shared by the navigator status
 * and the submit-confirmation count. null / undefined / '' / [] / {selected:null}
 * (an object whose every value is empty) are unanswered; 0 and false are answers.
 */
export function isAnsweredValue(ans: unknown): boolean {
  const empty = (v: unknown): boolean =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(ans)) return false;
  if (typeof ans === 'object' && !Array.isArray(ans)) {
    // structured_case: { steps: { [stepId]: number[] } } is answered iff some step has a pick.
    const st = (ans as { steps?: unknown }).steps;
    if (st !== null && typeof st === 'object' && !Array.isArray(st)) return Object.values(st as object).some((v) => !empty(v));
    const vals = Object.values(ans as Record<string, unknown>);
    return vals.some((v) => !empty(v));
  }
  return true;
}

export function AttemptPage(): React.JSX.Element {
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
  // Submit confirmation modal (replaces window.confirm / window.alert).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // M2a: drawer open state for the mobile bottom-sheet question navigator.
  // Desktop never opens it (the aside is always visible); mobile toggles via
  // the .aiq-attempt-nav-toggle header button. Closes on item-select.
  const [navOpen, setNavOpen] = useState(false);
  // Test sections: "Finish section" confirm dialog.
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const sectionQidsRef = useRef<string[]>([]);

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
            // eslint-disable-next-line no-console
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
  }, []);

  // ── Hooks (always called — args safe when not yet ready) ──────────────────

  const autosave = useAutosave({ attemptId, locked });

  const integrityCfg = pageState.tag === 'ready' ? pageState.view.integrity : undefined;
  const integrity = useIntegrityHooks({
    attemptId,
    currentQuestionId,
    enabled: !locked,
    blockCopyPaste: integrityCfg?.block_copy_paste === true,
    fullscreenRequired: integrityCfg?.fullscreen === true,
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

  // ── Test sections: follow the server to the next section ──────────────────
  // The view only ever contains the running section. After a section's timer ends
  // (or "Finish section"), fetch the view again and swap to the new section.
  const applyView = useCallback((view: CandidateAttemptViewWire) => {
    setAnswers((prev) => {
      const next = new Map(prev);
      for (const a of view.answers) if (!next.has(a.question_id)) next.set(a.question_id, a.answer);
      return next;
    });
    setFlags((prev) => {
      const next = new Map(prev);
      for (const a of view.answers) if (!next.has(a.question_id)) next.set(a.question_id, a.flagged);
      return next;
    });
    const first = [...view.questions].sort((a, b) => a.position - b.position)[0];
    setCurrentQuestionId(first?.question_id ?? null);
    setPageState({ tag: 'ready', view });
  }, []);

  const refreshAfterSectionChange = useCallback(
    async (fromSection: number, retriesLeft: number): Promise<void> => {
      const retry = (): void => {
        if (retriesLeft > 0) {
          setTimeout(() => void refreshAfterSectionChange(fromSection, retriesLeft - 1), 1000);
        }
      };
      try {
        const view = await getAttempt(attemptId);
        if (view.attempt.status !== 'in_progress') {
          setLocked(true); // the locked effect redirects to the submitted page
          return;
        }
        // Local clock a hair ahead of the server: still the same section — look again.
        if (view.sections !== undefined && view.sections.current === fromSection) {
          retry();
          return;
        }
        applyView(view);
      } catch {
        retry();
      }
    },
    [attemptId, applyView],
  );

  const handleFinishSection = useCallback(
    async (fromSection: number): Promise<void> => {
      setFinishing(true);
      setFinishError(null);
      try {
        await Promise.all(sectionQidsRef.current.map((id) => autosave.flushSave(id)));
        await finishSection(attemptId);
        setFinishOpen(false);
        await refreshAfterSectionChange(fromSection, 0);
      } catch (err) {
        setFinishError(
          err instanceof CandidateApiError
            ? err.apiError?.message ?? "Something went wrong. Please try again."
            : 'Could not finish the section. Please try again.',
        );
      } finally {
        setFinishing(false);
      }
    },
    [attemptId, autosave, refreshAfterSectionChange],
  );

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Flush the debounced autosave first: a click on Submit within the 5 s
      // debounce window otherwise submits with the last answer unsaved
      // (found by the e2e take-happy-path run, 2026-10-03).
      await Promise.all(sectionQidsRef.current.map((id) => autosave.flushSave(id)));
      const res = await submitAttempt(attemptId);
      clearBackup(attemptId);
      // Hand the submit response (result_expectation, email_masked,
      // turnaround_text) to the Submitted page; it falls back to GET /result
      // when the state is absent (e.g. timer-expiry auto-submit).
      navigate(`/take/attempt/${attemptId}/submitted`, { replace: true, state: res });
    } catch (err) {
      // Surface submit failures inline in the modal — don't swallow silently.
      setSubmitting(false);
      const msg =
        err instanceof CandidateApiError
          ? err.apiError?.message ?? "Something went wrong. Please try again."
          : err instanceof Error
            ? err.message
            : 'Unknown error. Please try again.';
      setSubmitError(`Submit failed: ${msg}`);
    }
  }, [attemptId, navigate, autosave]);

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
        }}
      >
        <Spinner size="md" />
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
        <div data-help-id="candidate.attempt.disconnect" style={{ maxWidth: 560, width: '100%' }}>
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

  // Test sections (absent for ordinary tests: everything below then behaves as before).
  const sec = view.sections;
  const isLastSection = sec === undefined || sec.current >= sec.total - 1;
  sectionQidsRef.current = sorted.map((q) => q.question_id);

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
    const isAnswered = isAnsweredValue(ans);

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

    return {
      questionId: qid,
      // Sectioned tests number from 1 inside each section.
      position: sec !== undefined ? sorted.indexOf(q) + 1 : q.position,
      status,
    };
  });

  // ── Submit-confirmation counts ─────────────────────────────────────────────
  const totalCount = sorted.length;
  // Same predicate as the navigator's 'answered' status (isAnsweredValue).
  const answeredCount = navigatorItems.filter((it) =>
    isAnsweredValue(answers.get(it.questionId)),
  ).length;
  const unansweredCount = totalCount - answeredCount;
  // Test sections: the final dialog counts EVERY section. The current section uses the
  // live local answers (autosave may lag); finished/upcoming ones use the server counts.
  const sectionLines = (view.sections_summary ?? []).map((s) =>
    s.status === 'current'
      ? { ...s, question_count: totalCount, answered_count: answeredCount }
      : s,
  );
  const overallUnanswered =
    sectionLines.length > 0
      ? sectionLines.reduce((n, s) => n + (s.question_count - s.answered_count), 0)
      : unansweredCount;
  const flaggedCount = sorted.filter((q) => flags.get(q.question_id) ?? false).length;

  // ── Navigator body (shared between desktop aside and mobile <Drawer>) ─────
  // Same JSX rendered in both surfaces — same items, same onSelect, same per-
  // cell states. The aside is hidden under [data-viewport="mobile"] (M2a CSS
  // in tokens.css); the Drawer mounts lazily only when navOpen is true.
  const navigatorBody = (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--aiq-space-sm)' }}>
        <CandidateHelp />
      </div>
      <QuestionNavigator
        items={navigatorItems}
        onSelect={(qid) => {
          setCurrentQuestionId(qid);
          setNavOpen(false); // close mobile drawer after pick; no-op on desktop
          // Navigator click does NOT flush; debounced autosave handles it.
        }}
      />
      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--aiq-space-xs)',
          marginTop: 'var(--aiq-space-md)',
          paddingLeft: 'var(--aiq-space-md)',
        }}
      >
        {[
          { color: 'var(--aiq-color-accent)', label: 'Current' },
          { color: 'var(--aiq-color-success-soft)', border: 'var(--aiq-color-success)', label: 'Answered' },
          { color: 'var(--aiq-color-warning-soft)', border: 'var(--aiq-color-warning)', label: 'Flagged' },
          { color: 'var(--aiq-color-bg-base)', border: 'var(--aiq-color-border)', label: 'Unseen' },
        ].map(({ color, border, label }) => (
          <span
            key={label}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--aiq-space-sm)', fontSize: 11, color: 'var(--aiq-color-fg-secondary)', fontFamily: 'var(--aiq-font-sans)' }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: color,
                border: border ? `1px solid ${border}` : undefined,
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        ))}
      </div>
    </>
  );

  // ── Locked banner ─────────────────────────────────────────────────────────
  const lockedBanner = locked ? (
    <div
      style={{
        padding: 'var(--aiq-space-sm) var(--aiq-space-2xl)',
        background: 'var(--aiq-color-warning-soft)',
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
      className="aiq-screen aiq-attempt-shell"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr auto',
        minHeight: '100vh',
        background: 'var(--aiq-color-bg-base)',
      }}
    >
      {integrity.fullscreenGateOpen && (
        <FullscreenGate exitCount={integrity.fullscreenExitCount} onEnter={integrity.enterFullscreen} />
      )}

      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <header className="aiq-attempt-top" style={TOP_BAR}>
        <Logo />

        {sec !== undefined && (
          <Chip variant="default" style={{ flexShrink: 0 }} data-help-id="candidate.attempt.section">
            Section {sec.current + 1} of {sec.total} · {sec.name}
          </Chip>
        )}

        <span style={{ ...COUNTER_LABEL, flex: 1 }}>
          Question {safeIdx + 1} of {sorted.length}
        </span>

        {sec?.calculator === true && <Calculator data-help-id="candidate.attempt.calculator" />}

        {sec !== undefined ? (
          // Section timer: re-keyed per section so it restarts on the next deadline.
          // The last section's end is the end of the test (existing expiry path).
          <AttemptTimer
            key={sec.current}
            endsAt={sec.ends_at}
            onExpire={isLastSection ? handleExpire : () => void refreshAfterSectionChange(sec.current, 5)}
            data-help-id="candidate.attempt.timer"
          />
        ) : (
          attempt.ends_at !== null && (
            <AttemptTimer
              endsAt={attempt.ends_at}
              onExpire={handleExpire}
              data-help-id="candidate.attempt.timer"
            />
          )
        )}

        <AutosaveIndicator
          status={autosave.status}
          lastSavedAt={autosave.lastSavedAt}
          retryCount={autosave.retryCount}
        />

        {/* M2a — mobile-only: open the bottom-sheet question navigator.
            Hidden on desktop (the right-side aside is always visible there). */}
        <button
          type="button"
          className="aiq-attempt-nav-toggle"
          onClick={() => setNavOpen(true)}
          aria-label="Open question navigator"
          data-help-id="candidate.attempt.navigator.toggle"
          style={{
            background: 'transparent',
            border: '1px solid var(--aiq-color-border-strong)',
            borderRadius: 'var(--aiq-radius-pill)',
            width: 36,
            height: 36,
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          <Icon name="grid" size={14} />
        </button>
      </header>

      {/* ── PROGRESS STRIP + LOCK NOTICE ─────────────────────────────── */}
      <div>
        <div style={{ height: 2, background: 'var(--aiq-color-bg-raised)' }}>
          <div
            style={{
              width: `${sorted.length > 0 ? ((safeIdx + 1) / sorted.length) * 100 : 0}%`,
              height: '100%',
              background: 'var(--aiq-color-accent)',
              transition: 'width 300ms ease',
            }}
          />
        </div>
        {lockedBanner}
      </div>

      {/* ── MIDDLE ROW (main pane + side panel) ─────────────────────────── */}
      <div
        className="aiq-attempt-middle"
        style={{
          display: 'grid',
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
          {integrity.showLeaveWarning && (
            <div style={{ marginBottom: 'var(--aiq-space-md)' }}>
              <IntegrityBanner
                kind="tab_was_blurred"
                message={`You left the assessment window ${integrity.leaveCount} time${integrity.leaveCount === 1 ? '' : 's'}. This is recorded and shared with your organisation.`}
                onDismiss={integrity.dismissLeaveWarning}
              />
            </div>
          )}
          {integrity.copyBlockedNotice && (
            <div
              role="status"
              aria-live="polite"
              style={{
                marginBottom: 'var(--aiq-space-md)',
                fontSize: 'var(--aiq-text-sm)',
                color: 'var(--aiq-color-fg-secondary)',
              }}
            >
              Copy and paste are turned off for this assessment.
            </div>
          )}

          {currentQuestion !== null ? (
            <>
              {/* Question text — canonical field names per type; no forbidden-synonym reads.
                   For scenario, title is the stem; intro is rendered inside ScenarioAnswerArea.
                   For all others, content.question is the stem.
                   If the content is malformed (forbidden synonym), skip the text; MalformedQuestion
                   is rendered by AnswerArea. */}
              {(() => {
                if (hasForbiddenSynonym(currentQuestion.content)) return null;
                const c = currentQuestion.content as Record<string, unknown>;
                const text =
                  currentQuestion.type === 'scenario' || currentQuestion.type === 'structured_case'
                    ? (typeof c.title === 'string' ? c.title : null)
                    : (typeof c.question === 'string' ? c.question : null);
                if (text === null) return null;
                return (
                  <p className="aiq-serif aiq-attempt-q-text" style={QUESTION_TEXT}>
                    {text}
                  </p>
                );
              })()}

              {/* Answer-format hint — instructional ("HOW to answer"), candidate-
                  safe (never a rubric/answer key), resolved server-side so it is
                  always present. Rendered once here so every question type shows
                  it directly above its answer input. Plain text only. */}
              {typeof currentQuestion.answer_guidance === 'string' &&
                currentQuestion.answer_guidance.trim() !== '' && (
                  <p
                    className="aiq-attempt-answer-guidance"
                    style={{
                      margin: '0 0 var(--aiq-space-sm)',
                      paddingLeft: 'var(--aiq-space-sm)',
                      borderLeft: '2px solid var(--aiq-color-border)',
                      fontFamily: 'var(--aiq-font-sans)',
                      fontSize: 'var(--aiq-text-sm)',
                      color: 'var(--aiq-color-fg-muted)',
                    }}
                  >
                    {currentQuestion.answer_guidance}
                  </p>
                )}

              {/* Type-switched answer area. The key resets local draft state
                  (numeric text box) when the question changes. */}
              <AnswerArea
                key={currentQuestion.question_id}
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

        {/* Side panel — hidden on mobile via .aiq-attempt-aside CSS rule;
            the same {navigatorBody} also renders inside the Drawer below. */}
        <aside
          className="aiq-attempt-aside"
          style={{
            borderLeft: '1px solid var(--aiq-color-border)',
            paddingLeft: 'var(--aiq-space-md)',
            background: 'var(--aiq-color-bg-raised)',
            paddingTop: 'var(--aiq-space-lg)',
            paddingBottom: 'var(--aiq-space-lg)',
            paddingRight: 'var(--aiq-space-md)',
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
            Navigator
          </div>
          {navigatorBody}
        </aside>
      </div>

      {/* ── BOTTOM BAR ──────────────────────────────────────────────────── */}
      <footer className="aiq-attempt-bottom" style={BOTTOM_BAR}>
        {/* Flag toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="aiq-attempt-flag-btn"
          onClick={handleFlagToggle}
          disabled={locked || currentQuestion === null}
          data-help-id="candidate.attempt.flag"
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

        {/* Spacer — hidden on mobile via .aiq-attempt-spacer CSS rule */}
        <span className="aiq-attempt-spacer" style={{ flex: 1 }} />

        {/* Prev */}
        <Button
          variant="outline"
          size="sm"
          className="aiq-attempt-prev-btn"
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
            className="aiq-attempt-next-btn"
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

        {/* Test sections: before the last section the primary action is "Finish section"
            (no way back); the last section keeps the normal Submit. */}
        {!isLastSection && (
          <Button
            variant="primary"
            size="sm"
            className="aiq-attempt-submit-btn"
            disabled={locked || finishing}
            onClick={() => {
              setFinishError(null);
              setFinishOpen(true);
            }}
          >
            Finish section
          </Button>
        )}

        {/* Submit — always visible; enabled even if not all questions answered.
            Opens the confirmation modal (counts of answered / unanswered / flagged). */}
        {isLastSection && (
        <Button
          variant="primary"
          size="sm"
          className="aiq-attempt-submit-btn"
          disabled={locked || submitting}
          data-help-id="candidate.attempt.submit.confirm"
          onClick={() => {
            setSubmitError(null);
            setConfirmOpen(true);
          }}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </Button>
        )}
      </footer>

      {/* ── FINISH SECTION CONFIRMATION (test sections) ─────────────────── */}
      <Modal
        open={finishOpen}
        onClose={() => {
          if (!finishing) setFinishOpen(false);
        }}
        title="Finish this section?"
      >
        <div style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)' }}>
          <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-fg-primary)' }}>
            You can't come back to this section.
          </p>
          <p style={{ margin: 0 }}>
            You answered {answeredCount} of {totalCount} questions here. Unanswered questions will score 0.
          </p>
          {finishError !== null && (
            <p role="alert" style={{ margin: '12px 0 0', color: 'var(--aiq-color-fg-primary)' }}>
              {finishError}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--aiq-space-sm)' }}>
          <Button variant="outline" disabled={finishing} onClick={() => setFinishOpen(false)}>
            Go back
          </Button>
          <Button
            variant="primary"
            disabled={finishing}
            onClick={() => void handleFinishSection(sec?.current ?? 0)}
          >
            {finishing ? 'Finishing…' : 'Finish section'}
          </Button>
        </div>
      </Modal>

      {/* ── SUBMIT CONFIRMATION ──────────────────────────────────────────
          Kit Modal: Esc / backdrop = Go back, focus moves in and Tab is trapped. */}
      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title="Submit your assessment?"
      >
        <div style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)' }}>
          {sectionLines.length === 0 ? (
            <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-fg-primary)' }}>
              You answered {answeredCount} of {totalCount} questions.
            </p>
          ) : (
            <ul
              data-help-id="candidate.attempt.submit_sections"
              style={{ margin: '0 0 8px', paddingLeft: 18, color: 'var(--aiq-color-fg-primary)' }}
            >
              {sectionLines.map((s) => (
                <li key={s.index}>
                  {s.name}: {s.answered_count} of {s.question_count} answered
                  {s.status === 'done' ? ' (closed, cannot be changed)' : ''}
                </li>
              ))}
            </ul>
          )}
          {overallUnanswered > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              {overallUnanswered} question{overallUnanswered !== 1 ? 's are' : ' is'} unanswered
              {sectionLines.length > 0 ? ' across all sections' : ''}
              {' '}— {overallUnanswered !== 1 ? 'they' : 'it'} will score 0.
            </p>
          )}
          {flaggedCount > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              {flaggedCount} question{flaggedCount !== 1 ? 's are' : ' is'} flagged for review.
            </p>
          )}
          <p style={{ margin: 0 }}>You cannot change your answers after you submit.</p>
          {submitError !== null && (
            <p role="alert" style={{ margin: '12px 0 0', color: 'var(--aiq-color-fg-primary)' }}>
              {submitError}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--aiq-space-sm)' }}>
          <Button variant="outline" disabled={submitting} onClick={() => setConfirmOpen(false)}>
            Go back
          </Button>
          <Button variant="primary" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? 'Submitting…' : 'Submit assessment'}
          </Button>
        </div>
      </Modal>

      {/* ── MOBILE NAVIGATOR DRAWER ───────────────────────────────────────
          Renders only when navOpen=true (Drawer returns null otherwise).
          The toggle button (in the header) is itself display:none on
          desktop, so navOpen will only flip on mobile. Same items, same
          onSelect, same backend semantics as the desktop aside. */}
      <Drawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="Navigator"
      >
        {navigatorBody}
      </Drawer>

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
}): React.JSX.Element {
  // Stage 1.5d shape lock: any forbidden synonym key in content triggers a
  // hard malformed fallback — no partial render of legacy rows.
  if (hasForbiddenSynonym(question.content)) {
    return <MalformedQuestion />;
  }

  if (!isQuestionType(question.type)) {
    return <UnknownTypeArea type={question.type} />;
  }
  const Renderer: QuestionRenderer | null = rendererMap[question.type];
  if (Renderer === null) return <UnknownTypeArea type={question.type} />;
  return (
    <Renderer
      question={question}
      content={question.content}
      answer={answer}
      disabled={disabled}
      onAnswerChange={onAnswerChange}
      onBlur={onBlur}
    />
  );
}
