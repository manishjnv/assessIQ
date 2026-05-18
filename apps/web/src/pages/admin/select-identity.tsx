// apps/web/src/pages/admin/select-identity.tsx
//
// P1 — Identity picker page. Shown when a Google-verified email maps to
// multiple tenant identities. No RequireSession wrapper — there is no session
// yet at this step; the continuation token is in an HttpOnly cookie.
//
// Flow:
//   1. On mount → GET /api/auth/login/identities (continuation cookie sent
//      automatically by the browser). Renders a list of identity buttons.
//   2. User clicks an identity → POST /api/auth/login/select { userId }.
//      On success, navigate to res.redirectTo.
//   3. On 401/expired (token consumed, expired, or missing) → redirect to
//      /admin/login with a "session expired" message.

import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Chip, Logo } from '@assessiq/ui-system';

interface IdentityOption {
  userId: string;
  role: string;
  tenantSlug: string;
  tenantName: string;
}

const SERIF_H1: CSSProperties = {
  fontSize: 36,
  lineHeight: 1.1,
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

export function AdminSelectIdentity(): JSX.Element {
  const navigate = useNavigate();
  const [identities, setIdentities] = useState<IdentityOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchIdentities(): Promise<void> {
      try {
        const res = await fetch('/api/auth/login/identities', {
          credentials: 'include',
          cache: 'no-store',
        });

        if (cancelled) return;

        if (!res.ok) {
          // 401 = token expired or invalid → back to login.
          navigate('/admin/login', {
            replace: true,
            state: { message: 'Session expired — please sign in again.' },
          });
          return;
        }

        const data = (await res.json()) as { identities: IdentityOption[] };
        if (cancelled) return;

        if (data.identities.length === 0) {
          navigate('/admin/login', { replace: true });
          return;
        }

        setIdentities(data.identities);
      } catch {
        if (!cancelled) {
          navigate('/admin/login', {
            replace: true,
            state: { message: 'Session expired — please sign in again.' },
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchIdentities();
    return () => { cancelled = true; };
  }, [navigate]);

  async function handleSelect(userId: string): Promise<void> {
    setSelecting(userId);
    setError(null);
    try {
      const res = await fetch('/api/auth/login/select', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });

      if (!res.ok) {
        // 401 = token consumed/expired; any other error = generic failure.
        navigate('/admin/login', {
          replace: true,
          state: { message: 'Session expired — please sign in again.' },
        });
        return;
      }

      const data = (await res.json()) as { redirectTo: string };
      window.location.href = data.redirectTo;
    } catch {
      setError('Something went wrong. Please try signing in again.');
      setSelecting(null);
    }
  }

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <main style={{ width: '100%', maxWidth: 420, padding: '48px 24px' }}>
        <Logo />

        <span style={{ display: 'inline-block', margin: '32px 0 24px' }}>
          <Chip variant="accent">Choose account</Chip>
        </span>

        <h1 className="aiq-serif" style={SERIF_H1}>
          Select your workspace.
        </h1>

        <p
          style={{
            color: 'var(--aiq-color-fg-secondary)',
            fontSize: 15,
            margin: '0 0 32px',
            lineHeight: 1.5,
            fontFamily: 'var(--aiq-font-sans)',
          }}
        >
          Your email is associated with multiple workspaces. Pick the one you
          want to sign in to.
        </p>

        {loading && (
          <div
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 12,
              color: 'var(--aiq-color-fg-muted)',
              textAlign: 'center',
              padding: '24px 0',
            }}
          >
            Loading…
          </div>
        )}

        {!loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {identities.map((identity) => (
              <Button
                key={identity.userId}
                size="lg"
                variant="outline"
                onClick={() => { void handleSelect(identity.userId); }}
                disabled={selecting !== null}
                style={{ width: '100%', justifyContent: 'flex-start' }}
              >
                <span style={{ fontWeight: 500 }}>
                  {roleLabelMap[identity.role] ?? identity.role}
                </span>
                <span
                  style={{
                    marginLeft: 8,
                    color: 'var(--aiq-color-fg-secondary)',
                    fontWeight: 400,
                  }}
                >
                  @ {identity.tenantName}
                </span>
              </Button>
            ))}
          </div>
        )}

        {error !== null && (
          <p
            style={{
              color: 'var(--aiq-color-danger, #e53e3e)',
              fontSize: 14,
              marginTop: 16,
              fontFamily: 'var(--aiq-font-sans)',
            }}
          >
            {error}
          </p>
        )}
      </main>
    </div>
  );
}

const roleLabelMap: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  reviewer: 'Reviewer',
  candidate: 'Candidate',
};
