// Local Real-mode behaviour of the free test: full screen where the browser allows it, a count of tab leaves,
// a flag when full screen is left. DISPLAY ONLY: nothing is recorded, stored or sent (no fetch, no storage, no
// recordEvent). Not useIntegrityHooks / FullscreenGate: those call the API. Never calls getUserMedia (no camera).
// `active` is true only while a Real run is on screen; a Mock run attaches no listeners.

import { useCallback, useEffect, useRef, useState } from 'react';

export const FS_NOTE = 'Full screen is not available here. Keep this tab open.';

export interface FreeRealState {
  /** One-line note when full screen could not start. */
  note: string | null;
  /** Times the tab went hidden and came back. */
  leaves: number;
  /** True after the user left full screen that this run started. */
  leftFullscreen: boolean;
  /** Call inside the Start click (a user gesture is needed for full screen). Resets the counters. */
  start: () => void;
  /** Call inside a click. */
  returnToFullscreen: () => void;
}

const enter = (onFail: () => void): void => {
  const el = document.documentElement;
  if (document.fullscreenEnabled !== true || typeof el.requestFullscreen !== 'function') return onFail();
  try {
    void Promise.resolve(el.requestFullscreen()).catch(onFail);
  } catch {
    onFail();
  }
};

export function useFreeRealMode(active: boolean): FreeRealState {
  const [note, setNote] = useState<string | null>(null);
  const [leaves, setLeaves] = useState(0);
  const [leftFullscreen, setLeft] = useState(false);
  const inFs = useRef(false);
  const wasHidden = useRef(false);
  const fail = useCallback(() => setNote(FS_NOTE), []);

  useEffect(() => {
    if (!active) return;
    inFs.current = document.fullscreenElement != null;
    wasHidden.current = false;
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') wasHidden.current = true;
      else if (wasHidden.current) {
        wasHidden.current = false;
        setLeaves((n) => n + 1);
      }
    };
    const onFs = (): void => {
      const now = document.fullscreenElement != null;
      if (inFs.current && !now) setLeft(true);
      if (now) setLeft(false);
      inFs.current = now;
    };
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('fullscreenerror', fail);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('fullscreenerror', fail);
      // stop(): finish, timeout or unmount. Exit only when this page is in full screen; ignore a rejection.
      if (document.fullscreenElement != null) {
        try {
          void Promise.resolve(document.exitFullscreen()).catch(() => undefined);
        } catch {
          /* nothing to exit */
        }
      }
    };
  }, [active, fail]);

  const start = useCallback(() => {
    setNote(null);
    setLeaves(0);
    setLeft(false);
    enter(fail);
  }, [fail]);

  return { note, leaves, leftFullscreen, start, returnToFullscreen: () => enter(fail) };
}
