// Candidate generic error static page.
// Route: /take/error  (registered in App.tsx by Opus)
//
// No API call — static presentation only. Shown when the attempt engine
// encounters an unrecoverable error and redirects here.
//
// E2E test take-error-pages.spec.ts matches:
//   getByRole("heading", { name: /(error|something went wrong)/i })
// The h1 "Something went wrong." satisfies that regex.

import { type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Logo } from '@assessiq/ui-system';
import { TakeRightPane } from './TakeRightPane.js';

// ─── shared style constants (mirrors login.tsx) ───────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const SERIF_H1: CSSProperties = {
  // CSS vars cascade from .aiq-take-twopane outer div (see tokens.css).
  // Desktop 44/1.05; mobile 30/1.1 — M1 phase of MOBILE_KIT_PORT.
  fontSize: 'var(--aiq-take-h1-size, 44px)',
  lineHeight: 'var(--aiq-take-h1-lh, 1.05)',
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

const BODY_P: CSSProperties = {
  color: 'var(--aiq-color-fg-secondary)',
  fontSize: 15,
  margin: '0 0 32px',
  lineHeight: 1.5,
};

export function ErrorPage(): JSX.Element {
  return (
    <div
      className="aiq-screen aiq-take-twopane"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gap: 0,
      }}
    >
      {/* Left — content pane */}
      <main
        className="aiq-take-main"
        style={{
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Logo />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '100%', maxWidth: 380 }}>
            <span style={{ display: 'inline-block', marginBottom: 24 }}>
              <Chip variant="accent" leftIcon="bell">Error</Chip>
            </span>
            <h1 className="aiq-serif" style={SERIF_H1}>
              Something went wrong.
            </h1>
            <p style={BODY_P}>
              We hit an unexpected error processing your assessment. Please ask
              your admin to resend the invitation.
            </p>
            <Link
              to="/"
              style={{
                textDecoration: 'none',
                display: 'inline-block',
                width: '100%',
              }}
            >
              <Button
                size="lg"
                variant="outline"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                Return to home
              </Button>
            </Link>
          </div>
        </div>
      </main>

      <TakeRightPane />
    </div>
  );
}
