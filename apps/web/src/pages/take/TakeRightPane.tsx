// Shared right pane for the /take/* two-column pages (TokenLanding, Expired, ErrorPage).
// Extracted from TokenLanding.tsx's local RightPane to eliminate copy-paste.
// Kit reference: screens/login.jsx right panel — editorial tone, serif quote.

import { Chip } from '@assessiq/ui-system';

export function TakeRightPane(): JSX.Element {
  return (
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
          assessiq.in
        </footer>
      </blockquote>
    </aside>
  );
}
