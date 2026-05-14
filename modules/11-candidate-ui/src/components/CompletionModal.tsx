import React, { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CompletionModalProps {
  credential_id: string;
  tier: 'completion' | 'distinction' | 'honors';
  course_title: string;
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
// Focus-trap helper
// ---------------------------------------------------------------------------

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CompletionModal({
  credential_id,
  tier,
  course_title,
  verify_url,
  pdf_url,
  onClose,
}: CompletionModalProps): React.ReactElement | null {
  const storageKey = `cert-modal-shown:${credential_id}:${tier}`;

  // Synchronous check on first render — prevents a visible flash.
  const [alreadyShown] = useState<boolean>(() => {
    const v = localStorage.getItem(storageKey);
    return v !== null && v !== '';
  });

  const modalRef = useRef<HTMLDivElement>(null);

  // Stable ref so the effect doesn't need onClose in its dep array.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (alreadyShown) {
      // Already shown — dismiss immediately without storing again.
      onCloseRef.current();
      return;
    }
    // First time showing: gate future mounts, then focus the first CTA.
    localStorage.setItem(storageKey, '1');
    if (modalRef.current) {
      const focusable = getFocusableElements(modalRef.current);
      focusable[0]?.focus();
    }
  }, [alreadyShown, storageKey]);

  // Nothing to render once dismissed.
  if (alreadyShown) return null;

  const linkedInShareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
    verify_url,
  )}`;

  const tierLabel = TIER_LABELS[tier];

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      onClose();
      return;
    }

    if (e.key === 'Tab' && modalRef.current) {
      const focusable = getFocusableElements(modalRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="completion-modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-help-id="candidate.cert.completion-modal"
        style={{
          background: 'var(--aiq-color-bg-base, #fff)',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-md)',
          padding: 'var(--aiq-space-xl)',
          maxWidth: '480px',
          width: '100%',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)',
        }}
      >
        <h2
          id="completion-modal-title"
          style={{
            margin: '0 0 var(--aiq-space-md)',
            fontSize: 'var(--aiq-text-2xl)',
            color: 'var(--aiq-color-fg-primary)',
            fontWeight: 700,
          }}
        >
          Congratulations!
        </h2>

        <p
          style={{
            margin: '0 0 var(--aiq-space-lg)',
            fontSize: 'var(--aiq-text-base)',
            color: 'var(--aiq-color-fg-secondary)',
          }}
        >
          You&rsquo;ve earned a{' '}
          <strong style={{ color: 'var(--aiq-color-fg-primary)' }}>{tierLabel}</strong>{' '}
          certificate for{' '}
          <strong style={{ color: 'var(--aiq-color-fg-primary)' }}>{course_title}</strong>.
        </p>

        <div
          style={{
            display: 'flex',
            gap: 'var(--aiq-space-md)',
            flexWrap: 'wrap',
          }}
        >
          <a href={pdf_url} download style={ACTION_STYLE}>
            Download PDF
          </a>

          <a
            href={linkedInShareUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={ACTION_STYLE}
          >
            Share on LinkedIn
          </a>

          <button type="button" onClick={onClose} style={ACTION_STYLE}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

CompletionModal.displayName = 'CompletionModal';
