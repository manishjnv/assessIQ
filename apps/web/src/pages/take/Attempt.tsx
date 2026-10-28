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
//   - No localStorage for candidate session. (Z-167: display prefs — theme, text size,
//     organisation display — are NOT a session: they hold no identity, token or answer.
//     They live in localStorage under "aiq.take.prefs", like the key-shortcut switch.)
//   - No attempt_events rendered to the candidate.
//   - No --aiq-color-bg-elevated (renamed --aiq-color-bg-raised).
//   - No import from **/AssessIQ_UI_Template/** (ESLint forbids).
//   - No Monaco / KQL editor (Phase 2 deferred, decision #11).

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, Navigate } from "react-router";
import { Button, Drawer, Icon, Modal, Spinner } from "@assessiq/ui-system";
import { IntegrityBanner, FullscreenGate, useAutosave, useIntegrityHooks, useMultiTabWarning, getAttempt, submitAttempt, finishSection, recordPosition, toggleFlag, clearBackup, readBackup, CandidateApiError, neighbor, filterSuffix, NavCollapseHandle } from "@assessiq/candidate-ui";
import type { CandidateAttemptViewWire, FrozenQuestionWire, AttemptAnswerWire, NavigatorFilter } from "@assessiq/candidate-ui";
import { isQuestionType } from "@assessiq/question-types";
import { STEM_FIELD, TYPE_LABEL, type PageState, hasForbiddenSynonym, BOTTOM_BAR, SR_ONLY, KBD_HINT, isAnsweredValue } from "./attempt-parts/shared.js";
import { AnswerArea } from "./attempt-parts/AnswerArea.js";
import { ReportProblemModal } from "./attempt-parts/ReportProblemModal.js";
import { NavigatorBody } from "./attempt-parts/NavigatorBody.js";
import { useMaxWidth } from "./attempt-parts/useMaxWidth.js";
import { AttemptTopBar } from "./attempt-parts/AttemptTopBar.js";
import { FinishSectionModal } from "./attempt-parts/FinishSectionModal.js";
import { KeyNav, KeyShortcutsToggle, useKeyShortcuts } from "./attempt-parts/KeyNav.js";
import { SubmitConfirmModal } from "./attempt-parts/SubmitConfirmModal.js";
import { useCameraCapture } from "./useCameraCapture.js";
import { CameraIndicator, CameraLostOverlay } from "./CameraIndicator.js";
import { QuestionCountdown } from "./attempt-parts/QuestionCountdown.js";
import { ProgressRow } from "./attempt-parts/ProgressRow.js";
import { useTakePrefs } from "./attempt-parts/takePrefs.js";
import "./take-theme.css";
export { isAnsweredValue } from "./attempt-parts/shared.js";

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
  const [keysOn, setKeysOn] = useKeyShortcuts();
  const [prefs, setPrefs] = useTakePrefs();
  // Z-169: the navigator filter also drives Previous, Next, the arrow keys and the footer label.
  const [navFilter, setNavFilter] = useState<NavigatorFilter>('all');
  // Z-168: bumping this remounts the answer area, so a renderer's local draft clears with "Clear response".
  const [clearNonce, setClearNonce] = useState(0);
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Submit confirmation modal (replaces window.confirm / window.alert).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // M2a: drawer open state for the mobile bottom-sheet question navigator.
  // Desktop never opens it (the aside is always visible); mobile toggles via
  // the .aiq-attempt-nav-toggle header button. Closes on item-select.
  const [navOpen, setNavOpen] = useState(false);
  // Z-170: at 900 px and below the navigator is a 68 px strip above the footer plus a bottom sheet.
  const stripMode = useMaxWidth(900);
  // Test sections: "Finish section" confirm dialog.
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const sectionQidsRef = useRef<string[]>([]);
  // FUT-4 / FUT-7: question deadlines from the position call; questions whose time is up;
  // a leave of a locked section waiting for the candidate's answer (target question id).
  const [questionEnds, setQuestionEnds] = useState<Map<string, string>>(new Map());
  const [timeUpIds, setTimeUpIds] = useState<Set<string>>(new Set());
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false); // EXP-28
  const markTimeUp = useCallback((qid: string): void => {
    setTimeUpIds((prev) => (prev.has(qid) ? prev : new Set(prev).add(qid)));
  }, []);

  // ── FUT-4 / FUT-7: tell the server where the candidate is ─────────────────
  // Sends the question viewed (starts its own timer, when its section has one). In a
  // free-movement test it also sends the section entered, which closes a locked block
  // that was left. A failed call is ignored: the server checks every save anyway.
  const readyView = pageState.tag === 'ready' ? pageState.view : null;
  const lastSectionSentRef = useRef<number | null>(null);
  useEffect(() => {
    if (readyView === null || currentQuestionId === null) return;
    const q = readyView.questions.find((x) => x.question_id === currentQuestionId);
    if (q === undefined || q.section_index === null || q.section_index === undefined) return;
    const freeMovement = readyView.sections === undefined && readyView.section_names !== undefined;
    const sendSection = freeMovement && lastSectionSentRef.current !== q.section_index;
    if (sendSection) lastSectionSentRef.current = q.section_index;
    Promise.resolve(
      recordPosition(attemptId, {
        question_id: currentQuestionId,
        ...(sendSection ? { section_index: q.section_index } : {}),
      }),
    )
      .then((res) => {
        // A3-1: the server sends a withheld question's content here, once the candidate may read it.
        const fresh = res?.question;
        if (fresh !== undefined) {
          setPageState((prev) =>
            prev.tag === 'ready' && prev.view.questions.some((x) => x.question_id === fresh.question_id && x.withheld)
              ? {
                  tag: 'ready',
                  view: { ...prev.view, questions: prev.view.questions.map((x) => (x.question_id === fresh.question_id ? fresh : x)) },
                }
              : prev,
          );
        }
        const ends = res?.question_ends_at;
        if (ends === null || ends === undefined) return;
        setQuestionEnds((prev) => new Map(prev).set(currentQuestionId, ends));
      })
      .catch(() => undefined);
  }, [attemptId, currentQuestionId, readyView]);

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

  const autosave = useAutosave({ attemptId, locked, onQuestionTimeUp: markTimeUp });

  const integrityCfg = pageState.tag === 'ready' ? pageState.view.integrity : undefined;
  const integrity = useIntegrityHooks({
    attemptId,
    currentQuestionId,
    enabled: !locked,
    blockCopyPaste: integrityCfg?.block_copy_paste === true,
    fullscreenRequired: integrityCfg?.fullscreen === true,
  });

  const { multiTabActive } = useMultiTabWarning({ attemptId });

  // Real-exam camera: does nothing unless the server says the camera is required.
  const camera = useCameraCapture(attemptId, { active: !locked && !submitting });

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
        <h1 style={SR_ONLY}>Loading assessment</h1>
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
        <h1 style={SR_ONLY}>Connection problem</h1>
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

  // Z-168: Clear response and the A-D / 1-5 keys go through handleAnswerChange (same autosave path).
  function handleClear(): void {
    if (!currentQuestion || locked) return;
    handleAnswerChange(null);
    setClearNonce((n) => n + 1);
  }
  function handlePick(i: number): void {
    if (!currentQuestion || locked || timeUpIds.has(currentQuestion.question_id)) return;
    const opts = (currentQuestion.content as { options?: unknown } | null)?.options;
    if (!Array.isArray(opts) || i >= opts.length) return;
    if (currentQuestion.type === 'mcq') {
      handleAnswerChange({ selected: i });
    } else if (currentQuestion.type === 'multi_select') {
      const cur = (answers.get(currentQuestion.question_id) as { selected?: unknown } | null | undefined)?.selected;
      const sel = Array.isArray(cur) ? cur.filter((x): x is number => typeof x === 'number') : [];
      handleAnswerChange({ selected: sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i].sort((a, b) => a - b) });
    }
  }

  // ── Navigator items ───────────────────────────────────────────────────────
  // Whole-test timer: the API returns every question and no `sections`; group by the
  // per-question section_index when the server also sent the names. Else flat list.
  const sectionNames = sec === undefined ? view.section_names : undefined;
  const sectionOfQuestion = (q: FrozenQuestionWire): { index: number; name: string } | undefined => {
    const i = q.section_index;
    const name = i === null || i === undefined ? undefined : sectionNames?.[i];
    return i !== null && i !== undefined && name !== undefined ? { index: i, name } : undefined;
  };
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
      answered: isAnswered,
      flagged: isFlagged,
      ...(sectionOfQuestion(q) !== undefined ? { section: sectionOfQuestion(q)! } : {}),
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

  // FUT-4: leaving a section marked `locked` asks first. Every other move goes straight through.
  const requestQuestion = (qid: string): void => {
    const from = currentQuestion?.section_index;
    const to = sorted.find((q) => q.question_id === qid)?.section_index;
    const timing = view.section_timing;
    const leavesLocked =
      from !== null && from !== undefined && to !== from && timing?.[from]?.locked === true;
    if (leavesLocked) {
      setPendingLeave(qid);
      return;
    }
    setCurrentQuestionId(qid);
  };
  // Z-169: with a filter on, Previous and Next jump to the next match (wrapping); with "all" they step by one.
  const curId = currentQuestion?.question_id ?? '';
  const prevTarget = neighbor(navigatorItems, curId, -1, navFilter);
  const nextTarget = neighbor(navigatorItems, curId, 1, navFilter);
  const goPrev = (): void => {
    if (prevTarget !== null) requestQuestion(prevTarget.questionId);
  };
  const goNext = (): void => {
    if (nextTarget !== null) requestQuestion(nextTarget.questionId);
  };
  const toggleNav = (): void => setPrefs({ navCollapsed: !prefs.navCollapsed });

  // ── Navigator body (shared between desktop aside and mobile <Drawer>) ─────
  // Same JSX rendered in both surfaces — same items, same onSelect, same per-
  // cell states. The aside is hidden under [data-viewport="mobile"] (M2a CSS
  // in tokens.css); the Drawer mounts lazily only when navOpen is true.
  const navigatorBody = (
    <NavigatorBody
      navigatorItems={navigatorItems}
      setCurrentQuestionId={requestQuestion}
      setNavOpen={setNavOpen}
      filter={navFilter}
      onFilterChange={setNavFilter}
      collapsed={prefs.navCollapsed}
    />
  );
  const stripBody = (
    <NavigatorBody
      navigatorItems={navigatorItems}
      setCurrentQuestionId={requestQuestion}
      setNavOpen={setNavOpen}
      filter={navFilter}
      onFilterChange={setNavFilter}
      layout="strip"
      trailing={
        <button
          type="button"
          className="aiq-qnav-btn aiq-take-strip-grid"
          aria-label="Open all questions"
          aria-haspopup="dialog"
          onClick={() => setNavOpen(true)}
        >
          <Icon name="grid" size={18} />
        </button>
      }
    />
  );
  // The drawer is always full size: no collapse handle there.
  const drawerBody = (
    <NavigatorBody
      navigatorItems={navigatorItems}
      setCurrentQuestionId={requestQuestion}
      setNavOpen={setNavOpen}
      filter={navFilter}
      onFilterChange={setNavFilter}
    />
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
      className="aiq-screen aiq-attempt-shell aiq-take-root"
      data-take-theme={prefs.theme}
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
        height: '100dvh',
        background: 'var(--aiq-color-bg-base)',
      }}
    >
      {integrity.fullscreenGateOpen && (
        <FullscreenGate exitCount={integrity.fullscreenExitCount} onEnter={integrity.enterFullscreen} />
      )}

      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <AttemptTopBar
        sec={sec}
        wholeTestSectionName={currentQuestion !== null ? sectionOfQuestion(currentQuestion)?.name : undefined}
        attempt={attempt}
        safeIdx={safeIdx}
        questionCount={sorted.length}
        isLastSection={isLastSection}
        handleExpire={handleExpire}
        refreshAfterSectionChange={refreshAfterSectionChange}
        autosave={autosave}
        setNavOpen={setNavOpen}
        companyName={view.company_name ?? ''}
        companyLogoUrl={view.company_logo_url ?? null}
        prefs={prefs}
        setPrefs={setPrefs}
        candidateName={view.candidate_name}
        candidateId={attempt.user_id}
        assessmentName={view.assessment_name}
        assessmentId={attempt.assessment_id}
      />

      {/* ── PROGRESS STRIP + LOCK NOTICE ─────────────────────────────── */}
      <section aria-label="Progress">
        <ProgressRow
          items={navigatorItems}
          safeIdx={safeIdx}
          answeredCount={answeredCount}
          onJump={requestQuestion}
        />
        {camera.state === 'on' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 'var(--aiq-space-2xs) var(--aiq-space-2xl)' }}>
            <CameraIndicator state={camera.state} />
          </div>
        )}
        {lockedBanner}
      </section>
      <CameraLostOverlay state={camera.state} onRetry={camera.retry} />

      {/* ── MIDDLE ROW (main pane + side panel) ─────────────────────────── */}
      <div
        className="aiq-attempt-middle"
        data-nav-collapsed={prefs.navCollapsed ? 'true' : undefined}
        style={{
          display: 'grid',
          overflow: 'hidden',
        }}
      >
        {/* Main pane (scrolls on its own: the page itself never scrolls) */}
        <main className="aiq-attempt-main" style={{ minWidth: 0 }}>
          <h1 style={SR_ONLY}>Assessment</h1>
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

          {currentQuestion !== null && currentQuestion.withheld ? (
            <p role="status" data-testid="attempt-question-loading">Loading question…</p>
          ) : currentQuestion !== null ? (
            <div
              className="aiq-take-stage"
              key={currentQuestion.question_id}
              data-has-passage={currentQuestion.passage !== undefined ? 'true' : 'false'}
            >
              {/* EXP-8: shared passage, plain text like the stem. Open by default; the candidate may fold it. */}
              {currentQuestion.passage !== undefined && (
                <details
                  key={currentQuestion.passage.id}
                  open
                  data-testid="attempt-passage"
                  className="aiq-take-passage-pane"
                  style={{ margin: '0 0 var(--aiq-space-md)', fontFamily: 'var(--aiq-font-sans)' }}
                >
                  <summary className="aiq-take-eyebrow" style={{ cursor: 'pointer', marginBottom: 8 }}>
                    {currentQuestion.passage.title ?? 'Passage'}
                  </summary>
                  <p className="aiq-take-passage" style={{ margin: 0 }} tabIndex={0} aria-label={currentQuestion.passage.title ?? 'Passage'}>
                    {currentQuestion.passage.body}
                  </p>
                </details>
              )}

              <div className="aiq-take-qpane" style={{ minWidth: 0 }}>
              {/* Z-168: type chip + flag pill (the flag moved up from the footer; same handler and help id). */}
              <div className="aiq-take-qhead">
                <span className="aiq-take-type-chip">{TYPE_LABEL[currentQuestion.type] ?? currentQuestion.type}</span>
                <button
                  type="button"
                  className="aiq-take-flag aiq-attempt-flag-btn"
                  aria-pressed={flags.get(currentQuestion.question_id) ?? false}
                  disabled={locked}
                  onClick={handleFlagToggle}
                  data-help-id="candidate.attempt.flag"
                  aria-keyshortcuts="F"
                >
                  <Icon name="flag" size={14} />
                  {flags.get(currentQuestion.question_id) ?? false ? 'Flagged' : 'Flag for review'}
                </button>
              </div>

              {/* Question text — canonical field names per type; no forbidden-synonym reads.
                   For scenario, title is the stem; intro is rendered inside ScenarioAnswerArea.
                   For all others, content.question is the stem.
                   If the content is malformed (forbidden synonym), skip the text; MalformedQuestion
                   is rendered by AnswerArea. */}
              {(() => {
                if (hasForbiddenSynonym(currentQuestion.content)) return null;
                const c = currentQuestion.content as Record<string, unknown>;
                const field = isQuestionType(currentQuestion.type) ? STEM_FIELD[currentQuestion.type] : 'question';
                const text = typeof c[field] === 'string' ? (c[field] as string) : null;
                if (text === null) return null;
                return (
                  <p className="aiq-serif aiq-attempt-q-text">
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
                    className="aiq-attempt-answer-guidance aiq-take-hint"
                  >
                    {currentQuestion.answer_guidance}
                  </p>
                )}

              {/* Type-switched answer area. The key resets local draft state
                  (numeric text box) when the question changes. */}
              {/* FUT-7: countdown while the question has its own time; a plain message once it is up. */}
              {!timeUpIds.has(currentQuestion.question_id) && questionEnds.get(currentQuestion.question_id) !== undefined && (
                <QuestionCountdown
                  key={`${currentQuestion.question_id}:${questionEnds.get(currentQuestion.question_id)}`}
                  endsAt={questionEnds.get(currentQuestion.question_id)!}
                  onExpire={() => {
                    autosave.stopQuestion(currentQuestion.question_id);
                    markTimeUp(currentQuestion.question_id);
                  }}
                />
              )}
              {timeUpIds.has(currentQuestion.question_id) && (
                <p
                  role="status"
                  data-help-id="candidate.attempt.question_time_up"
                  style={{ margin: '0 0 var(--aiq-space-sm)', fontFamily: 'var(--aiq-font-sans)', fontSize: 'var(--aiq-text-sm)', fontWeight: 600, color: 'var(--aiq-color-fg-primary)' }}
                >
                  Time is up for this question.
                </p>
              )}

              <AnswerArea
                key={`${currentQuestion.question_id}:${clearNonce}`}
                question={currentQuestion}
                answer={answers.get(currentQuestion.question_id) ?? null}
                disabled={locked || timeUpIds.has(currentQuestion.question_id)}
                onAnswerChange={handleAnswerChange}
                onBlur={handleAnswerBlur}
              />
              </div>
            </div>
          ) : (
            <p style={{ color: 'var(--aiq-color-fg-muted)', fontFamily: 'var(--aiq-font-sans)' }}>
              No questions available.
            </p>
          )}
        </main>

        {/* Side panel — hidden on mobile via .aiq-attempt-aside CSS rule;
            the Drawer below renders the same panel (without the collapse handle). */}
        <aside
          className="aiq-attempt-aside"
          style={{
            borderLeft: '1px solid var(--aiq-color-border)',
            background: 'var(--aiq-color-bg-raised)',
          }}
        >
          {/* Z-170: the pill sits outside the scrolling area so it can straddle the border. */}
          <NavCollapseHandle collapsed={prefs.navCollapsed} onToggle={toggleNav} />
          <div
            className="aiq-attempt-aside-scroll"
            style={{
              paddingLeft: 'var(--aiq-space-md)',
              paddingTop: 'var(--aiq-space-lg)',
              paddingBottom: 'var(--aiq-space-lg)',
              paddingRight: 'var(--aiq-space-md)',
            }}
          >
            {!prefs.navCollapsed && <div
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
            </div>}
            {navigatorBody}
          </div>
        </aside>
        {stripMode && <div className="aiq-attempt-strip">{stripBody}</div>}
      </div>

      {/* ── BOTTOM BAR ──────────────────────────────────────────────────── */}
      {/* Key hints are desktop-only (hidden under the mobile viewport). */}
      <style>{'[data-viewport="mobile"] .aiq-attempt-kbd{display:none}'}</style>
      <KeyNav onPrev={goPrev} onNext={goNext} onPick={handlePick} onFlag={handleFlagToggle} onToggleNav={toggleNav} enabled={keysOn} disabled={locked || confirmOpen || finishOpen || navOpen || pendingLeave !== null} />

      {/* FUT-4: confirm before leaving a locked section. Leave moves on; Stay keeps the candidate here. */}
      {currentQuestion !== null && (
        <ReportProblemModal
          attemptId={attemptId}
          questionId={currentQuestion.question_id}
          open={reportOpen}
          onClose={() => setReportOpen(false)}
        />
      )}
      <Modal
        open={pendingLeave !== null}
        onClose={() => setPendingLeave(null)}
        title="Leave this section?"
      >
        <div data-help-id="candidate.attempt.section_leave" style={{ fontFamily: 'var(--aiq-font-sans)', fontSize: 14, lineHeight: 1.6, color: 'var(--aiq-color-fg-secondary)' }}>
          <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-fg-primary)' }}>
            You cannot return to this section. Leave it now?
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--aiq-space-sm)' }}>
          <Button variant="outline" onClick={() => setPendingLeave(null)}>
            Stay
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const target = pendingLeave;
              setPendingLeave(null);
              if (target !== null) setCurrentQuestionId(target);
            }}
          >
            Leave
          </Button>
        </div>
      </Modal>
      <footer className="aiq-attempt-bottom" style={BOTTOM_BAR}>
        {/* Z-7: Submit / Finish section sits at the far LEFT, away from Prev and Next.
            Test sections: before the last section the primary action is "Finish section"
            (no way back); the last section keeps the normal Submit, which opens the
            confirmation modal. On mobile the CSS order puts it on its own row. */}
        {!isLastSection && (
          <Button
            variant="primary"
            size="lg"
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
        {isLastSection && (
          <Button
            variant="primary"
            size="lg"
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

        {/* Z-168: clear the answer of this question (same save path as any other change). */}
        <Button
          variant="ghost"
          size="sm"
          className="aiq-attempt-clear-btn"
          onClick={handleClear}
          disabled={locked || currentQuestion === null || timeUpIds.has(currentQuestion.question_id) || !isAnsweredValue(answers.get(currentQuestion.question_id))}
          data-help-id="candidate.attempt.clear"
          style={{ color: 'var(--aiq-color-fg-secondary)' }}
        >
          Clear response
        </Button>

        {/* EXP-28: report a problem with this question */}
        <Button
          variant="ghost"
          size="sm"
          className="aiq-attempt-report-btn"
          onClick={() => setReportOpen(true)}
          disabled={currentQuestion === null}
          data-help-id="candidate.attempt.report"
          style={{ color: 'var(--aiq-color-fg-secondary)' }}
        >
          Report a problem
        </Button>

        {/* Z-169: handoff footer filter pill. Shows while a navigator filter is on; the x clears it. */}
        {navFilter !== 'all' && (
          <button
            type="button"
            className="aiq-take-filter-pill"
            data-filter={navFilter}
            onClick={() => setNavFilter('all')}
            data-help-id="candidate.attempt.nav.filter"
          >
            {navFilter.toUpperCase()} ONLY · {navFilter === 'flagged' ? flaggedCount : navFilter === 'answered' ? answeredCount : unansweredCount}
            <span aria-hidden="true"> ×</span>
            <span style={SR_ONLY}> Clear filter</span>
          </button>
        )}

        {/* Spacer — hidden on mobile via .aiq-attempt-spacer CSS rule */}
        <span className="aiq-attempt-spacer" style={{ flex: 1 }} />

        {/* Z-41: WCAG 2.1.4 off switch for the P and N keys (desktop only, like the hints) */}
        <span className="aiq-attempt-kbd">
          <KeyShortcutsToggle on={keysOn} onChange={setKeysOn} />
        </span>

        {/* Prev */}
        <Button
          variant="outline"
          size="lg"
          className="aiq-attempt-prev-btn"
          disabled={locked || (navFilter === 'all' ? isFirst : prevTarget === null)}
          aria-keyshortcuts="P"
          onClick={goPrev}
        >
          <Icon name="arrowLeft" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
          Prev{filterSuffix(navFilter)}
          <kbd className="aiq-attempt-kbd" aria-hidden="true" style={KBD_HINT}>P</kbd>
        </Button>

        {/* Next (hidden on the last question) */}
        {(navFilter !== 'all' || !isLast) && (
          <Button
            variant="outline"
            size="lg"
            className="aiq-attempt-next-btn"
            disabled={locked || (navFilter !== 'all' && nextTarget === null)}
            aria-keyshortcuts="N"
            onClick={goNext}
          >
            Next{filterSuffix(navFilter)}
            <Icon name="arrow" size={14} style={{ marginLeft: 'var(--aiq-space-2xs)' }} />
            <kbd className="aiq-attempt-kbd" aria-hidden="true" style={KBD_HINT}>N</kbd>
          </Button>
        )}
      </footer>

      {/* ── FINISH SECTION CONFIRMATION (test sections) ─────────────────── */}
      <FinishSectionModal
        finishOpen={finishOpen}
        finishing={finishing}
        finishError={finishError}
        setFinishOpen={setFinishOpen}
        answeredCount={answeredCount}
        totalCount={totalCount}
        sec={sec}
        handleFinishSection={handleFinishSection}
      />

      {/* ── SUBMIT CONFIRMATION ── */}
      <SubmitConfirmModal
        confirmOpen={confirmOpen}
        submitting={submitting}
        submitError={submitError}
        setConfirmOpen={setConfirmOpen}
        sectionLines={sectionLines}
        answeredCount={answeredCount}
        totalCount={totalCount}
        overallUnanswered={overallUnanswered}
        flaggedCount={flaggedCount}
        handleSubmit={handleSubmit}
      />

      {/* ── MOBILE NAVIGATOR DRAWER ───────────────────────────────────────
          Renders only when navOpen=true (Drawer returns null otherwise).
          The toggle button (in the header) is itself display:none on
          desktop, so navOpen will only flip on mobile. Same items, same
          onSelect, same backend semantics as the desktop aside. */}
      <Drawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="Navigator"
        placement={stripMode ? "bottom" : "right"}
      >
        {drawerBody}
      </Drawer>

    </div>
  );
}

