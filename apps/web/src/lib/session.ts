import { useEffect, useState } from 'react';

export interface DevSession {
  tenantId: string;
  userId: string;
  role: 'admin' | 'reviewer' | 'candidate';
  totpVerified: boolean;
}

const KEY = 'aiq:dev-auth';

export function loadSession(): DevSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as DevSession; } catch { return null; }
}

export function saveSession(s: DevSession): void {
  window.sessionStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new CustomEvent('aiq:session-change'));
}

export function clearSession(): void {
  window.sessionStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent('aiq:session-change'));
}

export function useSession(): DevSession | null {
  const [session, setSession] = useState<DevSession | null>(loadSession());
  useEffect(() => {
    const onChange = (): void => setSession(loadSession());
    window.addEventListener('aiq:session-change', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('aiq:session-change', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return session;
}
