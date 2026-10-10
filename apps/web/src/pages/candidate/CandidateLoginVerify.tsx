import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spinner } from '@assessiq/ui-system';
import { api } from '../../lib/api.js';

// SPA landing for /candidate/login/verify?token=…
//
// Why this page exists: email-preview crawlers (Gmail, Outlook, Slack, Teams)
// prefetch link URLs with GET to render previews / scan for malware. If the
// email pointed at the API endpoint directly, those GETs would burn the
// single-use token before the candidate ever clicked. This page is the safe
// landing — it returns HTML on GET (idempotent, no token consumption); the
// actual verification happens via fetch POST from this page's JavaScript,
// which crawlers do not execute.
//
// Behaviour:
//   - On mount: read ?token=…, POST to /api/auth/candidate/verify-link
//   - 200 { ok: true,  redirect: '/candidate/results' }      → navigate there
//                                    (the server picks the target; /candidate/results since 2026-10-01)
//   - 200 { ok: false, error: 'invalid_link' }               → /candidate/login?error=invalid_link
//   - Network error / unexpected response                    → same failure landing
//   - Missing token in URL                                   → same failure landing

export function CandidateLoginVerify(): React.JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [message, setMessage] = useState<string>('Verifying…');

  useEffect(() => {
    const token = params.get('token');
    if (token === null || token.trim().length === 0) {
      navigate('/candidate/login?error=invalid_link', { replace: true });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        // A non-2xx throws and lands in the catch → same failure landing.
        const data = await api<{ ok: true; redirect: string } | { ok: false; error: string }>(
          '/auth/candidate/verify-link',
          { method: 'POST', body: JSON.stringify({ token }) },
        );
        if (cancelled) return;

        if (data.ok === true) {
          setMessage('Signed in. Redirecting…');
          navigate(data.redirect, { replace: true });
        } else {
          navigate('/candidate/login?error=invalid_link', { replace: true });
        }
      } catch {
        if (cancelled) return;
        navigate('/candidate/login?error=invalid_link', { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, params]);

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <Spinner size="lg" aria-label={message} />
        <p
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 14,
            color: 'var(--aiq-color-fg-secondary)',
            margin: 0,
          }}
        >
          {message}
        </p>
      </div>
    </div>
  );
}
