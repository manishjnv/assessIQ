import { useEffect, useRef, useState } from "react";

export interface UseMultiTabWarningArgs {
  attemptId: string;
}

export interface UseMultiTabWarningResult {
  /** True when another tab opened with the same attemptId in the last 5 seconds. */
  multiTabActive: boolean;
}

type ChannelMessage = { type: "hello" | "ping"; at: number };

const HEARTBEAT_MS = 3_000;
const MULTI_TAB_TIMEOUT_MS = 5_000;

export function useMultiTabWarning({
  attemptId,
}: UseMultiTabWarningArgs): UseMultiTabWarningResult {
  const [multiTabActive, setMultiTabActive] = useState(false);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // SSR / jsdom guard — BroadcastChannel may not exist in non-browser environments.
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(`aiq-attempt-${attemptId}`);
    channelRef.current = channel;

    // ── Message handler ────────────────────────────────────────────────────

    function scheduleReset() {
      // Clear any existing expiry timeout and start a fresh 5-second window.
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      setMultiTabActive(true);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setMultiTabActive(false);
      }, MULTI_TAB_TIMEOUT_MS);
    }

    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const { type } = event.data ?? {};
      if (type === "hello" || type === "ping") {
        scheduleReset();
      }
    };

    // ── Announce presence immediately ──────────────────────────────────────

    channel.postMessage({ type: "hello", at: Date.now() } satisfies ChannelMessage);

    // ── Periodic heartbeat ─────────────────────────────────────────────────

    heartbeatRef.current = setInterval(() => {
      channel.postMessage({ type: "ping", at: Date.now() } satisfies ChannelMessage);
    }, HEARTBEAT_MS);

    // ── Cleanup ────────────────────────────────────────────────────────────

    return () => {
      if (heartbeatRef.current !== null) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      channel.close();
      channelRef.current = null;
    };
  }, [attemptId]);

  return { multiTabActive };
}
