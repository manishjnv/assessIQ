import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

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
//   - 200 { ok: true,  redirect: '/candidate/certificates' } → navigate there
//   - 200 { ok: false, error: 'invalid_link' }               → /candidate/login?error=invalid_link
//   - Network error / unexpected response                    → same failure landing
//   - Missing token in URL                                   → same failure landing

export function CandidateLoginVerify(): JSX.Element {
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
        const res = await fetch('/api/auth/candidate/verify-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;

        if (!res.ok) {
          navigate('/candidate/login?error=invalid_link', { replace: true });
          return;
        }
        const data = (await res.json()) as
          | { ok: true; redirect: string }
          | { ok: false; error: string };
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
        <span
          role="status"
          aria-label={message}
          style={{
            display: 'inline-block',
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px solid var(--aiq-color-border)',
            borderTopColor: 'var(--aiq-color-accent)',
            animation: 'aiq-spin 0.8s linear infinite',
          }}
        />
        <style>{`@keyframes aiq-spin { to { transform: rotate(360deg); } }`}</style>
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
