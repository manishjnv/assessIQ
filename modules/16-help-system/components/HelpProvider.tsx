/**
 * HelpProvider — top-level React provider for the AssessIQ help system.
 *
 * On mount (or when page/audience/locale change):
 *  1. Checks localStorage for a cached response (TTL 1 h).
 *  2. If cache is stale/absent, fetches /api/help?page=&audience=&locale=
 *     with credentials:'include'.
 *  3. Populates the context entries Map and writes back to localStorage.
 *  4. On 4xx (e.g. unauthenticated public page), proceeds with an empty Map.
 *  5. On network/5xx error, sets error in context.
 *
 * An AbortController cancels in-flight requests when props change before
 * the fetch completes — prevents stale data from overwriting fresh state.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HelpReadEnvelope } from '../src/types.js';
import { HelpContext } from './HelpContext.js';
import type { HelpContextValue } from './HelpContext.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HelpProviderProps {
  /** Dot-separated page identifier, e.g. 'admin.assessments.create'. */
  page: string;
  audience: 'admin' | 'reviewer' | 'candidate' | 'all';
  /** BCP-47 locale tag. Default: 'en'. */
  locale?: string;
  children: React.ReactNode;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

const TTL_MS = 3_600_000; // 1 hour

interface CacheEntry {
  fetchedAt: number;
  entries: Array<[string, HelpReadEnvelope]>;
}

function buildCacheKey(audience: string, locale: string, page: string): string {
  return `help.${audience}.${locale}.${page}`;
}

function readCache(cacheKey: string): ReadonlyMap<string, HelpReadEnvelope> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (Date.now() - parsed.fetchedAt > TTL_MS) return null;
    return new Map(parsed.entries);
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, entries: ReadonlyMap<string, HelpReadEnvelope>): void {
  if (typeof window === 'undefined') return;
  try {
    const value: CacheEntry = {
      fetchedAt: Date.now(),
      entries: Array.from(entries.entries()),
    };
    localStorage.setItem(cacheKey, JSON.stringify(value));
  } catch {
    // localStorage full or unavailable — not fatal; help still works from memory.
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HelpProvider({
  page,
  audience,
  locale = 'en',
  children,
}: HelpProviderProps): React.ReactElement {
  const [entries, setEntries] = useState<ReadonlyMap<string, HelpReadEnvelope>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [drawerOpenKey, setDrawerOpenKey] = useState<string | null>(null);

  // Stable ref to the latest abort controller so we can cancel on re-effect.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // SSR guard: do not fetch outside a browser context.
    if (typeof window === 'undefined') return;

    const cacheKey = buildCacheKey(audience, locale, page);

    // 1. Try localStorage cache first.
    const cached = readCache(cacheKey);
    if (cached !== null) {
      setEntries(cached);
      setLoading(false);
      setError(null);
      return;
    }

    // 2. Cancel any in-flight request from a previous render cycle.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page, audience, locale });

    fetch(`/api/help?${params.toString()}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (controller.signal.aborted) return;

        if (res.status >= 400 && res.status < 500) {
          // 4xx — not authenticated or page not found. Proceed with empty map;
          // help degrades silently so missing content never blocks the host UI.
          setEntries((prev) => (prev.size === 0 ? prev : new Map()));
          setLoading(false);
          return;
        }

        if (!res.ok) {
          throw new Error(`[HelpProvider] /api/help responded with HTTP ${res.status}`);
        }

        // API contract: array of HelpReadEnvelope.
        const data = (await res.json()) as HelpReadEnvelope[];
        if (controller.signal.aborted) return;

        const newMap: Map<string, HelpReadEnvelope> = new Map(
          data.map((e) => [e.key, e]),
        );

        writeCache(cacheKey, newMap);

        setEntries(newMap);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // cancelled — not an error
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [page, audience, locale]);

  // ── Drawer state ─────────────────────────────────────────────────────────

  const openDrawer = useCallback((key?: string) => {
    setDrawerOpenKey(key ?? null);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpenKey(null);
  }, []);

  // ── recordFeedback ────────────────────────────────────────────────────────

  const recordFeedback = useCallback((key: string, thumbsUp: boolean) => {
    // Fire-and-forget: POST /api/help/track. Errors are intentionally swallowed.
    fetch('/api/help/track', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'feedback', key, thumbsUp }),
    }).catch(() => {
      // Intentionally ignored.
    });
  }, []);

  // ── Context value ─────────────────────────────────────────────────────────

  const value = useMemo<HelpContextValue>(
    () => ({
      page,
      audience,
      locale,
      entries,
      loading,
      error,
      drawerOpenKey,
      openDrawer,
      closeDrawer,
      recordFeedback,
    }),
    [page, audience, locale, entries, loading, error, drawerOpenKey, openDrawer, closeDrawer, recordFeedback],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

HelpProvider.displayName = 'HelpProvider';
