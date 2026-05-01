// Invite-accept — admin invitation token redemption.
//
// Ported from modules/17-ui-system/AccessIQ_UI_Template/screens/invite-accept.jsx
// per the canonical-template rule in docs/10-branding-guideline.md § 0.
//
// Translation notes (intentional divergences from screens/invite-accept.jsx):
//
// 1. NO design-canvas mode toggle — the template's top bar carries
//    pending/success/error buttons for the design canvas only. Live
//    state derives from the POST /invitations/accept response.
//
// 2. NO Logo or top-bar — the SPA shell currently has no global
//    header (App.tsx renders routes only). Phase 1+ will add an
//    auth shell with Logo. The mono page footer IS preserved.
//
// 3. Success state is transient — the SPA navigates to /admin/mfa
//    (or /admin/users when MFA_REQUIRED=false) immediately after
//    the cookie is set. The "success" state visual is therefore
//    only flashed if navigation is delayed (network jitter, slow
//    whoami refresh). The template demoes the success state for
//    completeness; the live page implementation goes straight from
//    pending → navigation, falling back to the success screen only
//    when the round-trip stalls.
//
// 4. The pending spinner uses an inline @keyframes block (matches
//    screens/invite-accept.jsx). Phase 1+ should hoist a typed
//    Spinner component into @assessiq/ui-system.

import { useEffect, useState, type CSSProperties } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, Chip } from '@assessiq/ui-system';
import { api, ApiCallError } from '../lib/api';
import { fetchWhoami } from '../lib/session';

interface AcceptResponse {
  user: {
    id: string;
    email: string;
    role: 'admin' | 'reviewer';
  };
  expiresAt: string;
}

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

type Mode = 'pending' | 'success' | 'error';

export function InviteAccept(): JSX.Element {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token');

  const [mode, setMode] = useState<Mode>('pending');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setMode('error');
      setError('No invitation token found in the URL.');
      return;
    }

    const controller = new AbortController();

    api<AcceptResponse>('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
      .then(async () => {
        // Cookie is set; refresh whoami so RequireSession sees the session
        // immediately on /admin/mfa, then redirect.
        await fetchWhoami(true);
        nav('/admin/mfa', { replace: true });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setMode('error');
        if (err instanceof ApiCallError) {
          setError(err.apiError.message);
        } else {
          setError('Failed to accept invitation. The link may have expired.');
        }
      });

    return () => controller.abort();
  }, [token, nav]);

  // Per-state copy from screens/invite-accept.jsx.
  const copy = {
    pending: {
      chip: { variant: 'default' as const, leftIcon: 'clock' as const, label: 'Verifying' },
      title: 'Confirming your invitation…',
      body: "We're checking the token and creating your session. This takes a second.",
    },
    success: {
      chip: { variant: 'success' as const, leftIcon: 'check' as const, label: 'Confirmed' },
      title: 'Welcome aboard.',
      body: 'Your account is ready. Redirecting you to the next step…',
    },
    error: {
      chip: { variant: 'default' as const, leftIcon: 'close' as const, label: 'Invitation error' },
      title: 'Could not accept invitation.',
      body:
        error ??
        'The link may have expired, already been used, or been revoked. Ask the admin who invited you to send a fresh link.',
    },
  }[mode];

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <main
        style={{
          flex: 1,
          display: 'grid',
          placeItems: 'center',
          padding: '48px 32px',
        }}
      >
        <Card
          padding="lg"
          style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}
        >
          <div style={{ marginBottom: 18, display: 'inline-block' }}>
            <Chip variant={copy.chip.variant} leftIcon={copy.chip.leftIcon}>
              {copy.chip.label}
            </Chip>
          </div>

          {/* Pending spinner — matches screens/invite-accept.jsx idiom. */}
          {mode === 'pending' && (
            <div
              aria-hidden
              style={{
                margin: '0 auto 18px',
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '2px solid var(--aiq-color-border)',
                borderTopColor: 'var(--aiq-color-accent)',
                animation: 'aiq-spin 0.8s linear infinite',
              }}
            />
          )}

          <h1
            className="aiq-serif"
            style={{
              fontSize: 26,
              lineHeight: 1.2,
              margin: '0 0 10px',
              fontWeight: 400,
              letterSpacing: '-0.015em',
            }}
          >
            {copy.title}
          </h1>
          <p
            style={{
              fontSize: 14,
              color: 'var(--aiq-color-fg-secondary)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {copy.body}
          </p>

          {/* Mono microcopy footer — only on pending */}
          {mode === 'pending' && token !== null && (
            <p style={{ ...META_LABEL, marginTop: 22, letterSpacing: '0.06em' }}>
              Token #{token.slice(0, 8)} · 72 h TTL
            </p>
          )}
        </Card>
      </main>

      {/* Mono footer — template idiom. */}
      <footer
        style={{
          ...META_LABEL,
          padding: '16px 32px',
          display: 'flex',
          gap: 16,
          borderTop: '1px solid var(--aiq-color-border)',
        }}
      >
        <span>Phase 0 · 2026</span>
        <span style={{ flex: 1 }} />
        <span>Single-use · 72 h TTL</span>
      </footer>

      {/* Spinner keyframes — co-located so the page is self-contained.
          Phase 1+ should promote into a typed Spinner in @assessiq/ui-system. */}
      <style>{'@keyframes aiq-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}
