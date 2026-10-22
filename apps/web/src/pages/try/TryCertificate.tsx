// Static SAMPLE certificate for the /try demo — styled like the real public
// verify page (modules/18-certification routes-public.ts) but fixed content,
// watermarked, no lookup, no network. Lives at /try/certificate, NOT /verify/*
// (that prefix is routed to the API at the edge).

import { useEffect, type CSSProperties } from 'react';
import { Link } from 'react-router';

const FIELDS: [string, string][] = [
  ['Credential ID', 'SAMPLE-0000-0000'],
  ['Name', 'Sample Candidate'],
  ['Course', 'AssessIQ Sample Assessment'],
  ['Issued by', 'AssessIQ (demo)'],
  ['Level', 'Demo'],
  ['Issued', 'Not issued: sample only'],
];

const LABEL: CSSProperties = {
  fontSize: '.75rem',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--aiq-color-fg-muted)',
  margin: 0,
};

export function TryCertificatePage(): React.JSX.Element {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Sample certificate | AssessIQ';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,follow';
    document.head.appendChild(meta);
    return () => {
      document.title = prev;
      meta.remove();
    };
  }, []);

  return (
    <main
      style={{
        fontFamily: 'var(--aiq-font-sans)',
        background: 'var(--aiq-color-bg-sunken)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflowX: 'hidden',
      }}
    >
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--aiq-color-bg-base)',
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,.1)',
          padding: '2rem 1.5rem',
          maxWidth: 540,
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        {/* Watermark: decorative, the same text is in the visible banner below. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: 'rotate(-24deg)',
            fontSize: 'clamp(28px, 9vw, 48px)',
            fontWeight: 800,
            textAlign: 'center',
            lineHeight: 1.1,
            color: 'rgba(185, 28, 28, .14)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          SAMPLE — not a real credential
        </div>

        <p
          role="note"
          style={{
            margin: '0 0 1rem',
            padding: '.5rem .75rem',
            background: 'var(--aiq-color-warning-soft)',
            color: 'color-mix(in oklch, var(--aiq-color-warning) 40%, black)',
            borderRadius: 6,
            fontSize: '.875rem',
            fontWeight: 600,
          }}
        >
          Sample — not a real credential. This page does not verify anything.
        </p>
        <span
          style={{
            display: 'inline-flex',
            padding: '.5rem 1.25rem',
            borderRadius: 9999,
            fontWeight: 600,
            background: 'var(--aiq-color-success-soft)',
            color: 'var(--aiq-color-success)',
            marginBottom: '1.5rem',
          }}
        >
          Sample: how a verified credential looks
        </span>
        {FIELDS.map(([label, value]) => (
          <div key={label} style={{ marginBottom: '.75rem' }}>
            <p style={LABEL}>{label}</p>
            <p
              style={{
                margin: 0,
                color: 'var(--aiq-color-fg-primary)',
                fontWeight: 500,
                ...(label === 'Credential ID'
                  ? { fontFamily: 'var(--aiq-font-mono)', fontSize: '.9rem', background: 'var(--aiq-color-bg-sunken)', padding: '.25rem .5rem', borderRadius: 4, display: 'inline-block' }
                  : {}),
              }}
            >
              {value}
            </p>
          </div>
        ))}
        <p style={{ margin: '1.5rem 0 0', fontSize: '.9rem' }}>
          <Link to="/try" style={{ color: 'var(--aiq-color-accent)', fontWeight: 600 }}>
            Back to the sample assessment
          </Link>
        </p>
      </div>
    </main>
  );
}
