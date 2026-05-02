import { useCallback, useEffect, useRef, useState } from "react";
import { saveAnswer, CandidateApiError } from "../api";
import { writeBackup } from "../resilience/localStorage-backup";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error" | "offline";

export interface UseAutosaveArgs {
  attemptId: string;
  /** Read-only — bumped by parent when remaining time hits 0 to lock writes. */
  locked: boolean;
  /** Debounce window in ms. Default: 5000. */
  debounceMs?: number;
}

export interface UseAutosaveResult {
  status: AutosaveStatus;
  lastSavedAt: string | null;
  retryCount: number;
  /** Schedule a debounced save. Multiple calls within debounceMs collapse
   *  into one. Each questionId has its own debounce timer. */
  queueSave: (
    questionId: string,
    answer: unknown,
    opts?: { editsCount?: number; timeSpentSeconds?: number }
  ) => void;
  /** Force an immediate save for `questionId` (used on field blur). */
  flushSave: (questionId: string) => Promise<void>;
}

interface QuestionState {
  pendingAnswer: unknown;
  pendingOpts: { editsCount?: number; timeSpentSeconds?: number };
  timer: ReturnType<typeof setTimeout> | null;
  clientRevision: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
}

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
const MAX_RETRIES = 5;

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_CAP_MS);
}

export function useAutosave({
  attemptId,
  locked,
  debounceMs = 5000,
}: UseAutosaveArgs): UseAutosaveResult {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Per-question state lives in a ref so it doesn't trigger re-renders on every
  // timer/revision update.
  const questionsRef = useRef<Map<string, QuestionState>>(new Map());

  // Stable ref to locked so the save closure can read the current value without
  // re-creating callbacks on every locked change.
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  // ── Core save function ────────────────────────────────────────────────────

  const runSave = useCallback(
    async (qid: string, skipRetryReset = false) => {
      const state = questionsRef.current.get(qid);
      if (!state) return;

      const { pendingAnswer, pendingOpts } = state;

      // Increment clientRevision for this question.
      state.clientRevision += 1;
      const revision = state.clientRevision;

      // Write localStorage backup before the network call so data is safe even
      // if the tab closes mid-flight.
      writeBackup(attemptId, {
        questionId: qid,
        answer: pendingAnswer,
        clientRevision: revision,
      });

      setStatus("saving");

      try {
        // exactOptionalPropertyTypes forbids passing `undefined` for optional
        // numeric fields — only include the keys when defined.
        await saveAnswer({
          attemptId,
          questionId: qid,
          answer: pendingAnswer,
          client_revision: revision,
          ...(pendingOpts.editsCount !== undefined
            ? { edits_count: pendingOpts.editsCount }
            : {}),
          ...(pendingOpts.timeSpentSeconds !== undefined
            ? { time_spent_seconds: pendingOpts.timeSpentSeconds }
            : {}),
        });

        state.retryAttempt = 0;
        if (!skipRetryReset) setRetryCount(0);
        setStatus("saved");
        setLastSavedAt(new Date().toISOString());
      } catch (err: unknown) {
        if (err instanceof CandidateApiError) {
          const code = err.status ?? 0;

          if (code >= 400 && code < 500) {
            // Client-side error (validation, locked by server). Do not retry.
            setStatus("error");
            setRetryCount(0);
            return;
          }

          // 5xx or other server error — enter retry loop.
        }

        if (
          err instanceof CandidateApiError ||
          err instanceof TypeError
        ) {
          // Network failure or server error — schedule retry.
          const attempt = state.retryAttempt;
          if (attempt >= MAX_RETRIES) {
            setStatus("error");
            return;
          }

          const online = typeof navigator !== "undefined" ? navigator.onLine : true;
          setStatus(online ? "error" : "offline");
          setRetryCount(attempt + 1);

          const delay = retryDelayMs(attempt);
          state.retryAttempt += 1;

          // Clear any existing retry timer before scheduling a new one.
          if (state.retryTimer !== null) {
            clearTimeout(state.retryTimer);
          }
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            if (!lockedRef.current) {
              runSave(qid, true);
            }
          }, delay);

          return;
        }

        // Unexpected non-API error — surface to the global error handler.
        throw err;
      }
    },
    [attemptId]
  );

  // ── queueSave ─────────────────────────────────────────────────────────────

  const queueSave = useCallback(
    (
      questionId: string,
      answer: unknown,
      opts: { editsCount?: number; timeSpentSeconds?: number } = {}
    ) => {
      if (lockedRef.current) return;

      let state = questionsRef.current.get(questionId);
      if (!state) {
        state = {
          pendingAnswer: answer,
          pendingOpts: opts,
          timer: null,
          clientRevision: 0,
          retryTimer: null,
          retryAttempt: 0,
        };
        questionsRef.current.set(questionId, state);
      } else {
        state.pendingAnswer = answer;
        state.pendingOpts = opts;
      }

      // Clear the existing debounce timer and start a fresh one.
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        state!.timer = null;
        runSave(questionId);
      }, debounceMs);
    },
    [debounceMs, runSave]
  );

  // ── flushSave ─────────────────────────────────────────────────────────────

  const flushSave = useCallback(
    async (questionId: string): Promise<void> => {
      if (lockedRef.current) return;

      const state = questionsRef.current.get(questionId);
      if (!state) return;

      // Cancel the pending debounce timer and run immediately.
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      await runSave(questionId);
    },
    [runSave]
  );

  // ── Online recovery ───────────────────────────────────────────────────────

  useEffect(() => {
    function handleOnline() {
      if (lockedRef.current) return;
      // Re-attempt any questions that have a pending retry timer already, or
      // any that are in error/offline state with a pending answer.
      questionsRef.current.forEach((state, qid) => {
        if (state.retryTimer !== null) {
          // A retry is already scheduled; clear it and retry immediately so the
          // candidate doesn't wait out the exponential back-off.
          clearTimeout(state.retryTimer);
          state.retryTimer = null;
          runSave(qid, true);
        }
      });
    }

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [runSave]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      questionsRef.current.forEach((state) => {
        if (state.timer !== null) clearTimeout(state.timer);
        if (state.retryTimer !== null) clearTimeout(state.retryTimer);
      });
    };
  }, []);

  return { status, lastSavedAt, retryCount, queueSave, flushSave };
}
