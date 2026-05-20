// Candidate expired-link static page.
// Route: /take/expired  (registered in App.tsx by Opus)
//
// No API call — static presentation only. Shown when the router or the
// attempt engine detects that the magic-link window has closed.
//
// E2E test take-error-pages.spec.ts matches:
//   getByRole("heading", { name: /expired/i })
// The h1 "This invitation has expired." satisfies that regex.

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

export function Expired(): JSX.Element {
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
              <Chip variant="default">Expired</Chip>
            </span>
            <h1 className="aiq-serif" style={SERIF_H1}>
              This invitation has expired.
            </h1>
            <p style={BODY_P}>
              Magic-link invitations are valid for a limited window. Ask your
              assessment admin to send a new one.
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
