import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, Chip } from '@assessiq/ui-system';
import { api, ApiCallError } from '../lib/api';
import { saveSession } from '../lib/session';

interface AcceptResponse {
  // FIXME(post-01-auth): real response will include a sessionToken / set-cookie.
  // Phase 0 mock: server returns userId, tenantId, role so we can seed the dev session.
  userId: string;
  tenantId: string;
  role: 'admin' | 'reviewer';
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
      .then((data) => {
        // FIXME(post-01-auth): swap dev session seeding for cookie-based auth set by server.
        // Do NOT store the original invitation token — only the server-issued session identity.
        saveSession({
          userId: data.userId,
          tenantId: data.tenantId,
          role: data.role,
          totpVerified: false,
        });
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
