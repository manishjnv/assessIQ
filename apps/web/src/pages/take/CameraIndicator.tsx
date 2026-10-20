// Real-exam camera UI: the "Camera on" pill and the lost-camera overlay.
import { Button } from '@assessiq/ui-system';
import type { CameraState } from './useCameraCapture.js';

export function CameraIndicator({ state }: { state: CameraState }): React.JSX.Element | null {
  if (state !== 'on') return null;
  return (
    <span
      data-help-id="candidate.attempt.camera_indicator"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--aiq-space-xs)',
        padding: '2px var(--aiq-space-sm)',
        borderRadius: 'var(--aiq-radius-md)',
        background: 'var(--aiq-color-success-soft)',
        color: 'var(--aiq-color-fg-primary)',
        fontFamily: 'var(--aiq-font-sans)',
        fontSize: 'var(--aiq-text-sm)',
      }}
    >
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--aiq-color-success)' }} />
      Camera on
    </span>
  );
}

export function CameraLostOverlay({ state, onRetry }: { state: CameraState; onRetry: () => void }): React.JSX.Element | null {
  if (state !== 'lost' && state !== 'denied') return null;
  const denied = state === 'denied';
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aiq-camera-lost-title"
      aria-describedby="aiq-camera-lost-text"
      data-help-id="candidate.attempt.camera_lost"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        background: 'color-mix(in srgb, var(--aiq-color-bg-base) 85%, transparent)',
        padding: 'var(--aiq-space-2xl)',
      }}
    >
      <div
        style={{
          maxWidth: 440,
          background: 'var(--aiq-color-bg-raised)',
          border: '1px solid var(--aiq-color-danger)',
          borderRadius: 'var(--aiq-radius-md)',
          padding: 'var(--aiq-space-xl)',
          fontFamily: 'var(--aiq-font-sans)',
          color: 'var(--aiq-color-fg-primary)',
        }}
      >
        <h2 id="aiq-camera-lost-title" style={{ margin: '0 0 var(--aiq-space-sm)' }}>
          {denied ? 'Camera access is blocked' : 'Your camera stopped'}
        </h2>
        <p id="aiq-camera-lost-text" style={{ margin: '0 0 var(--aiq-space-md)' }}>
          {denied
            ? 'Camera access is blocked. Allow the camera in your browser settings, then press Retry.'
            : 'Turn your camera back on to continue. Your time keeps running.'}
        </p>
        <Button variant="primary" size="lg" onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}
