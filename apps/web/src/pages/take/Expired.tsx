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

// ─── shared style constants (mirrors login.tsx) ───────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const SERIF_H1: CSSProperties = {
  fontSize: 44,
  lineHeight: 1.05,
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
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 0,
      }}
    >
      {/* Left — content pane */}
      <main
        style={{
          padding: '48px 64px',
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

        {/* Mono footer */}
        <div style={{ ...META_LABEL, display: 'flex', gap: 16 }}>
          <span>Phase 1 · 2026</span>
          <span style={{ flex: 1 }} />
          <span>Magic-link · candidate</span>
        </div>
      </main>

      {/* Right — context panel (same idiom as TokenLanding) */}
      <aside
        style={{
          background: 'var(--aiq-color-bg-raised)',
          borderLeft: '1px solid var(--aiq-color-border)',
          padding: 48,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: 460, textAlign: 'left' }}>
            <Chip variant="accent" leftIcon="sparkle">Phase 1</Chip>
            <p
              className="aiq-serif"
              style={{
                fontSize: 28,
                lineHeight: 1.3,
                margin: '24px 0 0',
                color: 'var(--aiq-color-fg-primary)',
                letterSpacing: '-0.015em',
              }}
            >
              Calm. Focused. One question at a time.
            </p>
          </div>
        </div>

        <blockquote
          className="aiq-serif"
          style={{
            fontSize: 22,
            lineHeight: 1.3,
            margin: 0,
            maxWidth: 480,
            color: 'var(--aiq-color-fg-primary)',
            letterSpacing: '-0.015em',
          }}
        >
          "Read carefully. The questions are scenario-driven; there are no trick
          options."
          <footer
            style={{
              marginTop: 12,
              fontFamily: 'var(--aiq-font-sans)',
              fontSize: 12,
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            assessiq.automateedge.cloud
          </footer>
        </blockquote>
      </aside>
    </div>
  );
}
