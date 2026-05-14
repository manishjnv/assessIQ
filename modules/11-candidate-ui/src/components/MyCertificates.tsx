import React, { useEffect, useState } from 'react';
import { Chip, Spinner } from '@assessiq/ui-system';
import { listMyCertificates, shareCertificateLinkedIn } from '../api.js';
import type { MyCertificate } from '../api.js';

// ---------------------------------------------------------------------------
// Tier badge configuration
// ---------------------------------------------------------------------------

const TIER_STYLES: Record<
  'completion' | 'distinction' | 'honors',
  { bg: string; fg: string; label: string }
> = {
  completion: {
    bg: 'var(--aiq-color-accent-soft)',
    fg: 'var(--aiq-color-accent)',
    label: 'Completion',
  },
  distinction: { bg: '#fef3c7', fg: '#d97706', label: 'Distinction' },
  honors: {
    bg: 'var(--aiq-color-success-soft)',
    fg: 'var(--aiq-color-success)',
    label: 'Honors',
  },
};

// ---------------------------------------------------------------------------
// Date formatter — constructed once, reused per render
// ---------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatDate(iso: string): string {
  return DATE_FMT.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: MyCertificate['tier'] }): React.ReactElement {
  const { bg, fg, label } = TIER_STYLES[tier];
  return (
    <span
      role="status"
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 'var(--aiq-radius-full, 9999px)',
        background: bg,
        color: fg,
        fontFamily: 'var(--aiq-font-mono)',
        fontSize: 'var(--aiq-text-xs)',
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared action button / link style
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

const ACTION_DISABLED_STYLE: React.CSSProperties = {
  ...ACTION_STYLE,
  opacity: 0.4,
  cursor: 'default',
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MyCertificates(): React.ReactElement {
  const [certs, setCerts] = useState<MyCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    listMyCertificates()
      .then((res) => setCerts(res.certificates))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Failed to load certificates'),
      )
      .finally(() => setLoading(false));
  }, []);

  const headingStyle: React.CSSProperties = {
    fontFamily: 'var(--aiq-font-serif)',
    fontSize: 'var(--aiq-text-3xl)',
    fontWeight: 400,
    margin: 0,
    letterSpacing: '-0.02em',
  };

  if (loading) {
    return (
      <main style={{ padding: 'var(--aiq-space-xl)' }}>
        <h1 style={headingStyle}>My Certificates.</h1>
        <div style={{ marginTop: 'var(--aiq-space-lg)' }}>
          <Spinner aria-label="Loading certificates" />
        </div>
      </main>
    );
  }

  if (error !== null) {
    return (
      <main style={{ padding: 'var(--aiq-space-xl)' }}>
        <h1 style={headingStyle}>My Certificates.</h1>
        <p role="alert" style={{ color: 'var(--aiq-color-danger)', margin: 'var(--aiq-space-md) 0 0' }}>
          {error}
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: 'var(--aiq-space-xl)', maxWidth: '720px' }}>
      <div style={{ marginBottom: 12 }}>
        <Chip leftIcon="grid">{certs.length} certificate{certs.length !== 1 ? 's' : ''}</Chip>
      </div>
      <h1 style={headingStyle}>My Certificates.</h1>
      <p style={{ fontSize: 14, color: 'var(--aiq-color-fg-secondary)', margin: '8px 0 var(--aiq-space-lg)', lineHeight: 1.5 }}>
        Your earned certificates across all completed assessments.
      </p>

      {certs.length === 0 ? (
        <p style={{ color: 'var(--aiq-color-fg-muted)', margin: 0 }}>
          Complete an assessment to earn your first certificate.
        </p>
      ) : (
        <div>
          {certs.map((cert) => {
            const isRevoked = cert.revoked_at !== null;
            const isHovered = hoveredId === cert.credential_id;
            const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
              cert.verify_url,
            )}`;

            return (
              <article
                key={cert.credential_id}
                aria-labelledby={`cert-${cert.credential_id}`}
                onMouseEnter={() => setHoveredId(cert.credential_id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  borderBottom: '1px solid var(--aiq-color-border)',
                  padding: 'var(--aiq-space-md) 0',
                  background: isHovered ? 'var(--aiq-color-bg-raised)' : 'transparent',
                  transition: 'background 150ms ease',
                }}
              >
                {/* Badge row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--aiq-space-md)',
                    flexWrap: 'wrap',
                    marginBottom: 'var(--aiq-space-md)',
                  }}
                >
                  <TierBadge tier={cert.tier} />

                  {isRevoked && (
                    <span
                      role="status"
                      aria-label={`Revoked: ${cert.revoke_reason ?? ''}`}
                      style={{
                        display: 'inline-block',
                        padding: '2px 10px',
                        borderRadius: 'var(--aiq-radius-full, 9999px)',
                        background: 'var(--aiq-color-danger-soft, rgba(220,38,38,0.1))',
                        color: 'var(--aiq-color-danger)',
                        fontFamily: 'var(--aiq-font-mono)',
                        fontSize: 'var(--aiq-text-xs)',
                        fontWeight: 600,
                      }}
                    >
                      Revoked
                    </span>
                  )}

                  {!cert.signed_hash_valid && !isRevoked && (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 10px',
                        borderRadius: 'var(--aiq-radius-full, 9999px)',
                        background: 'var(--aiq-color-warning-soft, rgba(245,158,11,0.1))',
                        color: 'var(--aiq-color-warning)',
                        fontFamily: 'var(--aiq-font-mono)',
                        fontSize: 'var(--aiq-text-xs)',
                        fontWeight: 600,
                      }}
                    >
                      Signature invalid
                    </span>
                  )}
                </div>

                {/* Credential ID */}
                <p style={{ margin: '0 0 4px' }}>
                  <span
                    id={`cert-${cert.credential_id}`}
                    style={{
                      fontFamily: 'var(--aiq-font-mono)',
                      fontSize: 'var(--aiq-text-sm)',
                      color: 'var(--aiq-color-fg-muted)',
                    }}
                  >
                    {cert.credential_id}
                  </span>
                </p>

                {/* Course title + level */}
                <p
                  style={{
                    margin: '0 0 4px',
                    fontSize: 'var(--aiq-text-base)',
                    color: 'var(--aiq-color-fg-primary)',
                    fontWeight: 600,
                  }}
                >
                  {cert.course_title}{' '}
                  <span style={{ color: 'var(--aiq-color-fg-secondary)', fontWeight: 400 }}>
                    &mdash; {cert.level}
                  </span>
                </p>

                {/* Issued date */}
                <p
                  style={{
                    margin: '0 0 var(--aiq-space-md)',
                    fontSize: 'var(--aiq-text-sm)',
                    color: 'var(--aiq-color-fg-muted)',
                  }}
                >
                  Issued {formatDate(cert.issued_at)}
                </p>

                {/* Action toolbar */}
                <div
                  role="toolbar"
                  aria-label="Certificate actions"
                  style={{ display: 'flex', gap: 'var(--aiq-space-md)', flexWrap: 'wrap' }}
                >
                  {/* Download PDF */}
                  {isRevoked ? (
                    <button type="button" disabled style={ACTION_DISABLED_STYLE}>
                      Download PDF
                    </button>
                  ) : (
                    <a href={cert.pdf_url} download style={ACTION_STYLE}>
                      Download PDF
                    </a>
                  )}

                  {/* Share on LinkedIn */}
                  {isRevoked ? (
                    <button type="button" disabled data-help-id="candidate.cert.share-linkedin" style={ACTION_DISABLED_STYLE}>
                      Share on LinkedIn
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-help-id="candidate.cert.share-linkedin"
                      style={ACTION_STYLE}
                      onClick={() => {
                        void shareCertificateLinkedIn(cert.credential_id);
                        window.open(linkedInUrl, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      Share on LinkedIn
                    </button>
                  )}

                  {/* Copy verify link — always enabled */}
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard.writeText(cert.verify_url).catch(() => {})
                    }
                    style={ACTION_STYLE}
                  >
                    Copy verify link
                  </button>

                  {/* View public page — always enabled */}
                  <a
                    target="_blank"
                    rel="noopener noreferrer"
                    href={cert.verify_url}
                    style={ACTION_STYLE}
                  >
                    View public page
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

MyCertificates.displayName = 'MyCertificates';
