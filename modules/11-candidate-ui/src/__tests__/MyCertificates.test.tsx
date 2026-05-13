// Tests for the MyCertificates candidate-facing certificate list.
// Pattern: vitest + jsdom + @testing-library/react, matching components.test.tsx.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MyCertificates } from '../components';
import type { MyCertificatesResponse } from '../api';

// ---------------------------------------------------------------------------
// Mock setup — vi.hoisted so the factory can reference the mock fn
// ---------------------------------------------------------------------------

const { mockListMyCertificates, mockShareCertificateLinkedIn } = vi.hoisted(() => ({
  mockListMyCertificates: vi.fn<() => Promise<MyCertificatesResponse>>(),
  mockShareCertificateLinkedIn: vi.fn<() => Promise<void>>(),
}));

vi.mock('../api.js', () => ({
  listMyCertificates: mockListMyCertificates,
  shareCertificateLinkedIn: mockShareCertificateLinkedIn,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_CERT: MyCertificatesResponse['certificates'][number] = {
  credential_id: 'CERT-001',
  tier: 'completion',
  course_title: 'JavaScript Fundamentals',
  level: 'Beginner',
  issued_at: '2026-01-15T00:00:00Z',
  revoked_at: null,
  revoke_reason: null,
  signed_hash_valid: true,
  verify_url: 'https://assessiq.example.com/verify/CERT-001',
  pdf_url: '/api/certificates/CERT-001/pdf',
  pdf_downloads: 3,
  linkedin_shares: 1,
  verification_views: 10,
};

const REVOKED_CERT: MyCertificatesResponse['certificates'][number] = {
  credential_id: 'CERT-002',
  tier: 'distinction',
  course_title: 'React Advanced',
  level: 'Advanced',
  issued_at: '2026-02-10T00:00:00Z',
  revoked_at: '2026-03-01T00:00:00Z',
  revoke_reason: 'Policy violation',
  signed_hash_valid: true,
  verify_url: 'https://assessiq.example.com/verify/CERT-002',
  pdf_url: '/api/certificates/CERT-002/pdf',
  pdf_downloads: 0,
  linkedin_shares: 0,
  verification_views: 2,
};

const TAMPERED_CERT: MyCertificatesResponse['certificates'][number] = {
  credential_id: 'CERT-003',
  tier: 'honors',
  course_title: 'TypeScript Mastery',
  level: 'Expert',
  issued_at: '2026-04-05T00:00:00Z',
  revoked_at: null,
  revoke_reason: null,
  signed_hash_valid: false,
  verify_url: 'https://assessiq.example.com/verify/CERT-003',
  pdf_url: '/api/certificates/CERT-003/pdf',
  pdf_downloads: 1,
  linkedin_shares: 0,
  verification_views: 5,
};

const THREE_CERTS: MyCertificatesResponse = {
  certificates: [ACTIVE_CERT, REVOKED_CERT, TAMPERED_CERT],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MyCertificates', () => {
  it('shows loading state before the API resolves', () => {
    // Never resolves — stays in loading state for the duration of the test.
    mockListMyCertificates.mockReturnValue(new Promise(() => {}));
    render(<MyCertificates />);
    expect(screen.getByText(/Loading your certificates/)).toBeDefined();
  });

  it('snapshot: renders all three cert rows after load', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    const { container } = render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    expect(container).toMatchSnapshot();
  });

  it('revoked row shows a Revoked badge with the revoke_reason in aria-label', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    // findByRole waits for the async state update to complete.
    const revokedBadge = await screen.findByRole('status', {
      name: /^Revoked: Policy violation/,
    });
    expect(revokedBadge).toBeDefined();
    expect(revokedBadge.textContent).toBe('Revoked');
  });

  it('tampered row (signed_hash_valid=false, not revoked) shows Signature invalid badge', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.getByText('Signature invalid')).toBeDefined();
    });
  });

  it('active cert Download PDF is an <a> (enabled)', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    // Three certs → three "Download PDF" entries. Active cert renders an <a>.
    const allDownload = screen.getAllByText('Download PDF');
    expect(allDownload).toHaveLength(3);
    const downloadAnchors = allDownload.filter((el) => el.tagName === 'A');
    // Active (CERT-001) and tampered (CERT-003) are links; revoked is a button.
    expect(downloadAnchors).toHaveLength(2);
  });

  it('revoked cert Download PDF is a disabled button', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    const disabledDownloads = screen
      .getAllByText('Download PDF')
      .filter((el) => el.tagName === 'BUTTON') as HTMLButtonElement[];
    expect(disabledDownloads).toHaveLength(1);
    expect(disabledDownloads[0]!.disabled).toBe(true);
  });

  it('revoked cert Share on LinkedIn is a disabled button', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    const disabledLinkedIn = screen
      .getAllByText('Share on LinkedIn')
      .filter(
        (el) => el.tagName === 'BUTTON' && (el as HTMLButtonElement).disabled,
      ) as HTMLButtonElement[];
    expect(disabledLinkedIn).toHaveLength(1);
    expect(disabledLinkedIn[0]!.disabled).toBe(true);
  });

  it('share button fires the counter POST before opening the LinkedIn composer', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    mockShareCertificateLinkedIn.mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });

    // 2 non-revoked certs (CERT-001, CERT-003) → 2 enabled share buttons;
    // 1 revoked cert (CERT-002) → 1 disabled share button.
    const allLinkedIn = screen.getAllByText('Share on LinkedIn');
    const enabledShareBtns = allLinkedIn.filter(
      (el) => el.tagName === 'BUTTON' && !(el as HTMLButtonElement).disabled,
    );
    expect(enabledShareBtns).toHaveLength(2);

    // Click the first enabled button (CERT-001 — ACTIVE_CERT).
    fireEvent.click(enabledShareBtns[0]!);

    expect(mockShareCertificateLinkedIn).toHaveBeenCalledWith('CERT-001');
    expect(openSpy).toHaveBeenCalledWith(
      'https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fassessiq.example.com%2Fverify%2FCERT-001',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('Copy verify link and View public page are always present and enabled', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    // 3 certs → 3 copy buttons, 3 view links — all enabled.
    const copyBtns = screen.getAllByText('Copy verify link') as HTMLButtonElement[];
    expect(copyBtns).toHaveLength(3);
    copyBtns.forEach((btn) => expect(btn.disabled).toBe(false));

    const viewLinks = screen.getAllByText('View public page');
    expect(viewLinks).toHaveLength(3);
    viewLinks.forEach((el) => expect(el.tagName).toBe('A'));
  });

  it('renders the empty state when the API returns no certificates', async () => {
    mockListMyCertificates.mockResolvedValue({ certificates: [] });
    render(<MyCertificates />);
    await waitFor(() => {
      expect(
        screen.getByText('Complete an assessment to earn your first certificate.'),
      ).toBeDefined();
    });
  });

  it('renders an error message when the API call rejects', async () => {
    mockListMyCertificates.mockRejectedValue(new Error('Network error'));
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeDefined();
    });
  });

  it('each cert article is labelled by its credential_id span', async () => {
    mockListMyCertificates.mockResolvedValue(THREE_CERTS);
    render(<MyCertificates />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
    // aria-labelledby points at id="cert-<credential_id>".
    // The id spans must be present in the DOM.
    expect(document.getElementById('cert-CERT-001')).not.toBeNull();
    expect(document.getElementById('cert-CERT-002')).not.toBeNull();
    expect(document.getElementById('cert-CERT-003')).not.toBeNull();
  });
});
