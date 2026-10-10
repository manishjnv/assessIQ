import { useCallback, useEffect, useRef, useState } from "react";
import { ApiCallError, createApiClient } from "@assessiq/http-client";

export interface UseApiOptions {
  /** API base override, default "/api". */
  base?: string;
  init?: RequestInit;
  /** false (or path = null) = idle, no request. */
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | undefined;
  error: ApiCallError | Error | null;
  loading: boolean;
  refetch: () => void;
}

const client = createApiClient("/api");

/**
 * GET-on-mount helper over the single @assessiq/http-client. Loads on mount and
 * when `path` changes; aborts the in-flight request on unmount, path change or
 * refetch. An AbortError is never surfaced as `error`.
 */
export function useApi<T = unknown>(path: string | null, opts: UseApiOptions = {}): UseApiResult<T> {
  const { base, enabled = true } = opts;
  const initRef = useRef(opts.init);
  initRef.current = opts.init;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiCallError | Error | null>(null);
  const active = enabled && path !== null;
  const [loading, setLoading] = useState(active);
  const [tick, setTick] = useState(0);
  // Previous response must not show under a new path or base. A plain refetch keeps it.
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!active || path === null) {
      setLoading(false);
      return;
    }
    const key = `${base ?? ""}|${path}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(undefined);
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    client<T>(path, { ...initRef.current, ...(base !== undefined ? { base } : {}), signal: ctl.signal })
      .then((d) => {
        if (ctl.signal.aborted) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted || (e instanceof Error && e.name === "AbortError")) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => ctl.abort();
  }, [path, base, active, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refetch };
}
