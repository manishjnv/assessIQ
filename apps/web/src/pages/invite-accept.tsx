import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, Chip } from '@assessiq/ui-system';
import { api, ApiCallError } from '../lib/api';
import { fetchWhoami } from '../lib/session';

// Server response shape for POST /api/invitations/accept.
// The session is set via Set-Cookie (httpOnly+Secure+SameSite=Lax); the
// SPA does NOT receive a session token in the body — that's the codex:rescue
// HIGH finding from W5. We just navigate to /admin/mfa and let the cookie
// + whoami round-trip drive RequireSession.
interface AcceptResponse {
  user: {
    id: string;
    email: string;
    role: 'admin' | 'reviewer';
  };
  expiresAt: string;
}

export function InviteAccept(): JSX.Element {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token');

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    if (!token) {
      setError('No invitation token found in the URL.');
      setPending(false);
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
        if (err instanceof ApiCallError) {
          setError(err.apiError.message);
        } else {
          setError('Failed to accept invitation. The link may have expired.');
        }
        setPending(false);
      });

    return () => controller.abort();
  }, [token, nav]);

  if (pending && !error) {
    return (
      <div
        className="aiq-screen"
        style={{ minHeight: '100vh', padding: '64px 32px', display: 'grid', placeItems: 'center' }}
      >
        <Card padding="lg" style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
          <p
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 12,
              color: 'var(--aiq-color-fg-muted)',
            }}
          >
            Verifying invitation…
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', padding: '64px 32px', display: 'grid', placeItems: 'center' }}
    >
      <Card padding="lg" style={{ width: '100%', maxWidth: 420 }}>
        <Chip>Invitation error</Chip>
        <h1 className="aiq-serif" style={{ fontSize: 28, margin: '16px 0 8px' }}>
          Could not accept invitation.
        </h1>
        <p style={{ fontSize: 14, color: 'var(--aiq-color-fg-secondary)', marginBottom: 0 }}>
          {error ?? 'An unexpected error occurred.'}
        </p>
      </Card>
    </div>
  );
}
