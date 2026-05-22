// Shared helper for the Phase D "state-aware login banner".
//
// When a session is destroyed mid-use by a tenant suspend/archive or a user
// disable/delete, the server returns 401 with `details.scope` ("tenant"|"user").
// lib/session.ts (and the admin-dashboard mirror) stashes that scope into
// sessionStorage under `aiq.lastAuthScope`; the admin and candidate login pages
// read it on mount to render coherent copy instead of a generic "session
// expired" feel.
//
// This module centralises the two fragile bits so the two login pages don't
// drift: (1) the single-shot read+clear, and (2) the scope→copy mapping
// (audience-tuned: admins get operator-facing copy, candidates get calmer
// assessment-facing copy). Each page owns its own visual treatment (the admin
// login is single-column; the candidate login uses its two-pane alert style).

const STORAGE_KEY = 'aiq.lastAuthScope';

export type AuthScope = 'tenant' | 'user';

/**
 * Read the revocation scope stashed on the last 401-with-scope, then clear it
 * so the banner shows exactly once (single-shot). Returns null when the key is
 * absent, unparseable, or carries an unrecognised scope. Never throws —
 * sessionStorage access can fail in private/incognito modes.
 */
export function readAuthScopeOnce(): AuthScope | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(STORAGE_KEY); // single-shot — clear on read
    const parsed = JSON.parse(raw) as { scope?: unknown };
    if (parsed.scope === 'tenant' || parsed.scope === 'user') return parsed.scope;
    return null;
  } catch {
    return null;
  }
}

export interface AuthScopeBannerCopy {
  title: string;
  body: string;
}

/**
 * Map a revocation scope to banner copy for the given audience.
 *
 * Admins see operator-facing copy ("an administrator has suspended…"); a
 * candidate sees calmer, assessment-facing copy pointing at their assessment
 * administrator. The error `code`/raw message are never surfaced — the scope
 * is the only signal, so a cookie-holder cannot distinguish "my account was
 * disabled" from "my company was suspended" via the string itself.
 */
export function authScopeCopy(
  scope: AuthScope,
  audience: 'admin' | 'candidate',
): AuthScopeBannerCopy {
  if (scope === 'tenant') {
    return audience === 'candidate'
      ? {
          title: "Your organisation's access is paused.",
          body: 'Your assessment workspace has been suspended. Please contact your assessment administrator.',
        }
      : {
          title: "Your organisation's access is paused.",
          body: 'An administrator has suspended or archived your company workspace. Please contact your administrator to restore access.',
        };
  }
  // scope === 'user'
  return audience === 'candidate'
    ? {
        title: 'Your access has been removed.',
        body: 'Your account is no longer active. Please contact your assessment administrator if you think this is a mistake.',
      }
    : {
        title: 'Your account has been disabled.',
        body: 'An administrator has disabled or removed your account. Please contact your administrator if you believe this is a mistake.',
      };
}
