// AssessIQ — @assessiq/admin-dashboard session hook.
//
// Thin session cache over GET /api/auth/whoami.
// Mirrors apps/web/src/lib/session.ts in pattern.
// Kept separate so there's no circular dep from module → apps/web.

import { useEffect, useState } from "react";
import { adminApi, AdminApiError } from "./api.js";

export interface AdminSessionInfo {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: "admin" | "reviewer" | "candidate" | "api-key";
  };
  tenant: {
    id: string;
    slug: string | null;
  };
  mfaStatus: "verified" | "pending" | "n/a";
}

let cached: AdminSessionInfo | null | undefined = undefined;
const subscribers = new Set<(s: AdminSessionInfo | null) => void>();

function notify(s: AdminSessionInfo | null): void {
  for (const fn of subscribers) fn(s);
}

export async function fetchAdminWhoami(
  force = false,
): Promise<AdminSessionInfo | null> {
  if (!force && cached !== undefined) return cached;
  try {
    const s = await adminApi<AdminSessionInfo>("/auth/whoami");
    cached = s;
    notify(s);
    return s;
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 401) {
      cached = null;
      notify(null);
      return null;
    }
    throw err;
  }
}

export function clearAdminSessionCache(): void {
  cached = undefined;
  notify(null);
}

export function useAdminSession(): {
  session: AdminSessionInfo | null;
  loading: boolean;
} {
  const [session, setSession] = useState<AdminSessionInfo | null>(
    cached ?? null,
  );
  const [loading, setLoading] = useState(cached === undefined);

  useEffect(() => {
    let cancelled = false;
    const handler = (s: AdminSessionInfo | null): void => {
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
      void fetchAdminWhoami().finally(() => {
        if (!cancelled) setLoading(false);
      });
    }

    return () => {
      subscribers.delete(handler);
      cancelled = true;
    };
  }, []);

  return { session, loading };
}

export async function adminLogout(): Promise<void> {
  await adminApi("/auth/logout", { method: "POST" });
  clearAdminSessionCache();
}
