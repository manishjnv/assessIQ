// Z-82: camera consent screen on the pre-test page. Shown after the readiness check passes, only for a
// real exam with camera_required. The text follows docs/design/2026-10-20-camera-consent-flow-draft.md section 5.
// The server stores the decision and refuses the start without an agreed record.

import { Button } from '@assessiq/ui-system';

const SECTION: React.CSSProperties = {
  marginBottom: 16,
  padding: '14px 16px',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-md)',
  background: 'var(--aiq-color-bg-raised)',
};

const TITLE: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-sans)',
  fontSize: 14,
  fontWeight: 600,
  margin: '0 0 10px',
  color: 'var(--aiq-color-fg-primary)',
};

const BODY: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-sans)',
  fontSize: 13,
  color: 'var(--aiq-color-fg-secondary)',
  lineHeight: 1.6,
};

export function CameraConsent({
  organisation,
  busy,
  allowDisabled = false,
  declined,
  onAllow,
  onDecline,
  onBack,
}: {
  /** Organisation name from the preview payload. Empty falls back to "Your test organiser". */
  organisation: string;
  busy: boolean;
  /** The general test consent is not ticked yet. */
  allowDisabled?: boolean;
  /** True after the candidate chose not to start. Only the message and a way back show. */
  declined: boolean;
  onAllow: () => void;
  onDecline: () => void;
  onBack: () => void;
}): React.JSX.Element {
  if (declined) {
    return (
      <section data-help-id="candidate.intro.camera_consent" aria-label="Camera consent" style={SECTION}>
        <p role="alert" style={{ ...BODY, margin: '0 0 12px', fontWeight: 600, color: 'var(--aiq-color-fg-primary)' }}>
          You did not start the test. Contact your test organiser if you want to take it in another way.
        </p>
        <Button size="sm" variant="outline" onClick={onBack}>
          Back to the start
        </Button>
      </section>
    );
  }

  const org = organisation.trim() !== '' ? organisation.trim() : 'Your test organiser';
  return (
    <section data-help-id="candidate.intro.camera_consent" aria-label="Camera consent" style={SECTION}>
      <h2 style={TITLE}>This test uses your camera</h2>
      <ul style={{ ...BODY, margin: '0 0 12px', paddingLeft: 20 }}>
        <li>
          <strong>Why:</strong> {org} asks for the camera to check that you take this test yourself and without help.
        </li>
        <li>
          <strong>What we record:</strong> photos during the test, and short low-size video when something looks wrong. We
          do not record sound. We do not match your face to other pictures. We do not score your face or your mood.
        </li>
        <li>
          <strong>Who sees it:</strong> only people at {org} who review test problems, and AssessIQ staff who support them.
          Every view is logged.
        </li>
        <li>
          <strong>How long we keep it:</strong> photos 90 days and video 7 days. If a problem is raised about your test, the
          files stay until it is closed, and for no more than one year.
        </li>
        <li>
          <strong>Your choices:</strong> you can say no. Then the test does not start, and you can talk to your test
          organiser. You can ask {org} to show you or erase your files at any time.
        </li>
      </ul>
      <p style={{ ...BODY, margin: '0 0 12px' }}>
        By choosing &quot;Allow camera and start&quot; you agree to this use for this test only.
      </p>
      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <Button size="lg" variant="primary" onClick={onAllow} disabled={busy || allowDisabled} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Starting…' : 'Allow camera and start'}
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={onDecline}
          disabled={busy}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          I do not agree, do not start
        </Button>
      </div>
      <p style={{ ...BODY, margin: 0, fontSize: 12 }}>
        Read the <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>privacy notice</a> and the{' '}
        <a href="/dpa" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>AssessIQ DPA summary</a>.
      </p>
    </section>
  );
}
