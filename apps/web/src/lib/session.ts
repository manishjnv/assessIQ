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
    role: 'admin' | 'reviewer' | 'candidate' | 'api-key';
  };
  tenant: {
    id: string;
    slug: string | null;
  };
  mfaStatus: 'verified' | 'pending' | 'n/a';
}

// Cache state: undefined = not yet fetched; null = fetched, no session.
let cached: SessionInfo | null | undefined = undefined;
let inFlight: Promise<SessionInfo | null> | null = null;
const subscribers = new Set<(s: SessionInfo | null) => void>();

function notify(s: SessionInfo | null): void {
  for (const fn of subscribers) fn(s);
}

export async function fetchWhoami(force = false): Promise<SessionInfo | null> {
  if (!force && cached !== undefined) return cached;
  if (inFlight) return inFlight;
  inFlight = api<SessionInfo>('/auth/whoami')
    .then((s) => {
      cached = s;
      notify(s);
      return s;
    })
    .catch((err) => {
      if (err instanceof ApiCallError && err.status === 401) {
        cached = null;
        notify(null);
        return null;
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
