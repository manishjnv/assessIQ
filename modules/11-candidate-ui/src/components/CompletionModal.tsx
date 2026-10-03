import React, { useEffect, useState } from 'react';
import { Modal } from '@assessiq/ui-system';
import { listMyCertificates } from '../api.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CompletionModalProps {
  credential_id: string;
  tier: 'completion' | 'distinction' | 'honors';
  assessment_title: string;
  verify_url: string;
  pdf_url: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Tier label map
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<CompletionModalProps['tier'], string> = {
  completion: 'Completion',
  distinction: 'Distinction',
  honors: 'Honors',
};

// ---------------------------------------------------------------------------
// Shared action style — mirrors MyCertificates.tsx ACTION_STYLE
// ---------------------------------------------------------------------------

const ACTION_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '4px var(--aiq-space-md)',
  border: '1px solid var(--aiq-color-border)',
  borderRadius: 'var(--aiq-radius-sm)',
  fontSize: 'var(--aiq-text-sm)',
  color: 'var(--aiq-color-fg-secondary)',
  background: 'transparent',
  textDecoration: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  lineHeight: 1.5,
};

// ---------------------------------------------------------------------------
// Per-browser seen-set (localStorage). Storage can throw (private mode, blocked
// site data): reads then report "not seen", writes are skipped.
// ---------------------------------------------------------------------------

const SEEN_KEY = 'aiq:certs-seen';

function readSeen(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function hasSeenCertificate(credentialId: string): boolean {
  return readSeen().includes(credentialId);
}

export function markCertificateSeen(credentialId: string): void {
  try {
    const seen = readSeen();
    if (!seen.includes(credentialId)) {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, credentialId]));
    }
  } catch {
    // ponytail: storage unavailable -> modal may show again next visit.
  }
}

// ---------------------------------------------------------------------------
// Controlled modal (kit Modal: focus trap, Escape, backdrop close)
// ---------------------------------------------------------------------------

export function CompletionModal({
  credential_id: _credentialId,
  tier,
  assessment_title,
  verify_url,
  pdf_url,
  onClose,
}: CompletionModalProps): React.ReactElement {
  const linkedInShareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
    verify_url,
  )}`;

  return (
    <Modal open onClose={onClose} title="Congratulations!">
      <div data-help-id="candidate.cert.completion_modal">
        <p
          style={{
            margin: '0 0 var(--aiq-space-lg)',
            fontSize: 'var(--aiq-text-base)',
            color: 'var(--aiq-color-fg-secondary)',
          }}
        >
          You&rsquo;ve earned a{' '}
          <strong style={{ color: 'var(--aiq-color-fg-primary)' }}>{TIER_LABELS[tier]}</strong>{' '}
          certificate for{' '}
          <strong style={{ color: 'var(--aiq-color-fg-primary)' }}>{assessment_title}</strong>.
        </p>

        <div style={{ display: 'flex', gap: 'var(--aiq-space-md)', flexWrap: 'wrap' }}>
          <a href={pdf_url} download style={ACTION_STYLE}>
            Download PDF
          </a>
          <a href={linkedInShareUrl} target="_blank" rel="noopener noreferrer" style={ACTION_STYLE}>
            Share on LinkedIn
          </a>
          <button type="button" onClick={onClose} style={ACTION_STYLE}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

CompletionModal.displayName = 'CompletionModal';

// ---------------------------------------------------------------------------
// NewCertificateModal — shows CompletionModal once for a not-yet-seen,
// non-revoked certificate. Reuses listMyCertificates (already returns tier,
// title, pdf_url); the released-result payload stays unchanged. Only mounted
// on a released result, so the result-release rule still gates it.
// ---------------------------------------------------------------------------

export function NewCertificateModal({
  credential_id,
}: {
  credential_id: string;
}): React.ReactElement | null {
  const [cert, setCert] = useState<Awaited<ReturnType<typeof listMyCertificates>>['certificates'][number] | null>(null);

  useEffect(() => {
    if (hasSeenCertificate(credential_id)) return;
    let live = true;
    listMyCertificates()
      .then((res) => {
        const c = res.certificates.find((x) => x.credential_id === credential_id);
        if (live && c && c.revoked_at === null) setCert(c);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [credential_id]);

  if (cert === null) return null;
  return (
    <CompletionModal
      credential_id={cert.credential_id}
      tier={cert.tier}
      assessment_title={cert.course_title}
      verify_url={cert.verify_url}
      pdf_url={cert.pdf_url}
      onClose={() => {
        markCertificateSeen(cert.credential_id);
        setCert(null);
      }}
    />
  );
}
