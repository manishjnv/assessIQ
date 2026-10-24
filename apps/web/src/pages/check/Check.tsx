// Z-154: standalone device check at /check. Public: no token, no session, no camera, no Begin button.
// The result stays on this page. The same readiness rules run as on the take page (readiness.ts).

import { Logo } from '@assessiq/ui-system';
import { ReadinessPanel, useReadiness } from '../take/ReadinessPanel.js';

export function CheckPage(): React.JSX.Element {
  const state = useReadiness(true, false, false);
  return (
    <div className="aiq-screen" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', padding: 24 }}>
      <Logo />
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 440 }}>
          <h1 style={{ fontSize: 28, fontWeight: 400, margin: '0 0 12px' }}>Test your device</h1>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--aiq-color-fg-secondary)' }}>
            Check your device before your exam. You do not need your invitation link for this check.
          </p>
          {state.passed && (
            <p role="status" style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'var(--aiq-color-fg-primary)' }}>
              Your device is ready.
            </p>
          )}
          <ReadinessPanel state={state} optional={false} />
        </div>
      </main>
    </div>
  );
}
