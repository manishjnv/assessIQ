// Tests for the CompletionModal component.
// Pattern: vitest + jsdom + @testing-library/react, matching MyCertificates.test.tsx.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { CompletionModal, NewCertificateModal } from '../components';
import { hasSeenCertificate } from '../components/CompletionModal';
import type { CompletionModalProps } from '../components';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROPS: CompletionModalProps = {
  credential_id: 'CERT-001',
  tier: 'completion',
  assessment_title: 'JavaScript Fundamentals',
  verify_url: 'https://assessiq.example.com/verify/CERT-001',
  pdf_url: '/api/certificates/CERT-001/pdf',
  onClose: vi.fn(),
};


// ---------------------------------------------------------------------------
// Cleanup after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionModal', () => {
  it('renders the dialog with tier and assessment title', () => {
    render(<CompletionModal {...BASE_PROPS} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Congratulations!')).toBeDefined();
    expect(screen.getByText(/JavaScript Fundamentals/)).toBeDefined();
  });

  it('Escape and Close call onClose', () => {
    const onClose = vi.fn();
    render(<CompletionModal {...BASE_PROPS} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('CTAs: Download PDF and LinkedIn are links, Close is a button', () => {
    render(<CompletionModal {...BASE_PROPS} onClose={vi.fn()} />);
    expect(screen.getByText('Download PDF').tagName).toBe('A');
    expect(screen.getByText('Share on LinkedIn').tagName).toBe('A');
    expect(screen.getByText('Close').tagName).toBe('BUTTON');
  });
});

describe('NewCertificateModal', () => {
  const CERT = {
    credential_id: 'CERT-001', tier: 'completion', course_title: 'JavaScript Fundamentals', level: 'L1',
    issued_at: '2026-01-01T00:00:00Z', revoked_at: null, revoke_reason: null, signed_hash_valid: true,
    verify_url: BASE_PROPS.verify_url, pdf_url: BASE_PROPS.pdf_url,
    pdf_downloads: 0, linkedin_shares: 0, verification_views: 0,
  };

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ certificates: [CERT] }), { status: 200 }),
    );
  });

  it('shows once, closing marks it seen, a remount shows nothing', async () => {
    const { unmount } = render(<NewCertificateModal credential_id="CERT-001" />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hasSeenCertificate('CERT-001')).toBe(true);
    unmount();
    render(<NewCertificateModal credential_id="CERT-001" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still renders when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<NewCertificateModal credential_id="CERT-001" />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
