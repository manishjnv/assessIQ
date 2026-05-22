import { useEffect, useState } from 'react';
import { api, ApiCallError } from './api';

// Session info as returned by GET /api/auth/whoami. Replaces the pre-W4
// dev-mock that synthesized sessions in sessionStorage. The aiq_sess cookie
// is the source of truth; this hook just caches the most recent whoami
// response so multiple components don't fan-out the same fetch.

export interface SessionInfo {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: 'admin' | 'super_admin' | 'reviewer' | 'candidate' | 'api-key';
  };
  tenant: {
    id: string;
    slug: string | null;
  };
  mfaStatus: 'verified' | 'pending' | 'n/a';
  /** True if the user has completed TOTP enrollment. Absent for API-key sessions. */
  totpEnrolled?: boolean;
  /** ISO 8601 UTC expiry of the current session cookie. Absent for API-key paths. */
  expiresAt?: string;
}

// Cache state: undefined = not yet fetched; null = fetched, no session.
let cached: SessionInfo | null | undefined = undefined;
let inFlight: Promise<SessionInfo | null> | null = null;
// Rate-limit cooldown: epoch ms before which we must NOT re-fire whoami. Set
// when a probe returns 429 (the anonymous IP bucket is shared by the entire
// pre-auth login bootstrap, so re-firing on every protected-route mount just
// burns more of that budget and prolongs the lockout). 0 = no cooldown.
let throttledUntil = 0;
const subscribers = new Set<(s: SessionInfo | null) => void>();

function notify(s: SessionInfo | null): void {
  for (const fn of subscribers) fn(s);
}

export async function fetchWhoami(force = false): Promise<SessionInfo | null> {
  if (!force && cached !== undefined) return cached;
  if (inFlight) return inFlight;
  // Back off while throttled. A `force` refresh (e.g. immediately after a
  // successful login) always bypasses the cooldown so the new session is seen.
  if (!force && Date.now() < throttledUntil) return cached ?? null;
  inFlight = api<SessionInfo>('/auth/whoami')
    .then((s) => {
      cached = s;
      throttledUntil = 0;
      notify(s);
      return s;
    })
    .catch((err) => {
      if (err instanceof ApiCallError && err.status === 401) {
        // Phase D: stash `details.scope` (and `reason`) so the login page can
        // render state-aware copy after a tenant suspend / user disable kicks
        // the session out. Single-shot — the login page clears it after read.
        const details = err.apiError.details;
        const scope = details?.['scope'];
        const reason = details?.['reason'];
        if (typeof scope === 'string') {
          try {
            sessionStorage.setItem(
              'aiq.lastAuthScope',
              JSON.stringify({
                scope,
                reason: typeof reason === 'string' ? reason : undefined,
              }),
            );
          } catch {
            // sessionStorage may throw in private/incognito modes — ignore.
          }
        }
        cached = null;
        notify(null);
        return null;
      }
      if (err instanceof ApiCallError && err.status === 429) {
        // Throttled (anonymous IP bucket exhausted). Honour the server's
        // Retry-After (details.retryAfterSeconds) and stop re-probing until it
        // elapses. Do NOT poison `cached` — a valid cookie may well exist; this
        // is transient. Surface "no session for now" so the gate routes to
        // /admin/login, which fires no further probe (no amplification loop).
        const retryAfter = Number(err.apiError.details?.['retryAfterSeconds']);
        // Clamp to [1, 300]s: fall back to 30 on a non-finite/non-positive
        // value, and cap the cooldown so a misconfigured/hostile proxy can't
        // black out the client for hours. The server's own window is ≤60s.
        const cooldownSeconds = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30, 300);
        throttledUntil = Date.now() + cooldownSeconds * 1000;
        return cached ?? null;
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function clearSessionCache(): void {
  cached = undefined;
  throttledUntil = 0;
  notify(null);
}

export function useSession(): { session: SessionInfo | null; loading: boolean } {
  const [session, setSession] = useState<SessionInfo | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);

  useEffect(() => {
    let cancelled = false;
    const handler = (s: SessionInfo | null): void => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    };
    subscribers.add(handler);

    if (cached !== undefined) {
      setSession(cached);
      setLoading(false);
    } else {
      setLoading(true);
      fetchWhoami()
        .then((s) => {
          if (!cancelled) {
            setSession(s);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSession(null);
            setLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
      subscribers.delete(handler);
    };
  }, []);

  return { session, loading };
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    clearSessionCache();
  }
}
