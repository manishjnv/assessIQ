// Tests for the CompletionModal component.
// Pattern: vitest + jsdom + @testing-library/react, matching MyCertificates.test.tsx.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { CompletionModal } from '../components';
import type { CompletionModalProps } from '../components';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROPS: CompletionModalProps = {
  credential_id: 'CERT-001',
  tier: 'completion',
  course_title: 'JavaScript Fundamentals',
  verify_url: 'https://assessiq.example.com/verify/CERT-001',
  pdf_url: '/api/certificates/CERT-001/pdf',
  onClose: vi.fn(),
};

const STORAGE_KEY = `cert-modal-shown:${BASE_PROPS.credential_id}:${BASE_PROPS.tier}`;

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
  it('renders modal content when localStorage key is absent', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);

    render(<CompletionModal {...BASE_PROPS} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Congratulations!')).toBeDefined();
    expect(screen.getByText(/JavaScript Fundamentals/)).toBeDefined();
  });

  it('calls onClose immediately when localStorage key is already set (does NOT render modal)', async () => {
    const onClose = vi.fn();
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('1');

    render(<CompletionModal {...BASE_PROPS} onClose={onClose} />);

    // Modal content must not be rendered.
    expect(screen.queryByRole('dialog')).toBeNull();

    // onClose is called via useEffect — wait for it to fire.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('sets localStorage key on first render', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    render(<CompletionModal {...BASE_PROPS} onClose={vi.fn()} />);

    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, '1');
  });

  it('ESC keydown calls onClose', () => {
    const onClose = vi.fn();
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);

    render(<CompletionModal {...BASE_PROPS} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Close button click calls onClose', () => {
    const onClose = vi.fn();
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);

    render(<CompletionModal {...BASE_PROPS} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('all 3 CTAs present: "Download PDF" as <a>, "Share on LinkedIn" as <a>, "Close" as <button>', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);

    render(<CompletionModal {...BASE_PROPS} onClose={vi.fn()} />);

    const downloadPdf = screen.getByText('Download PDF');
    expect(downloadPdf.tagName).toBe('A');

    const shareLinkedIn = screen.getByText('Share on LinkedIn');
    expect(shareLinkedIn.tagName).toBe('A');

    const closeBtn = screen.getByText('Close');
    expect(closeBtn.tagName).toBe('BUTTON');
  });
});
