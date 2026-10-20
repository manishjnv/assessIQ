// Z-82: the camera consent screen. The flow (Allow and Decline calls) is tested in TokenLanding.test.tsx.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CameraConsent } from './CameraConsent';

const handlers = (): { onAllow: () => void; onDecline: () => void; onBack: () => void } => ({
  onAllow: vi.fn(),
  onDecline: vi.fn(),
  onBack: vi.fn(),
});

afterEach(() => {
  cleanup();
});

describe('CameraConsent', () => {
  it('shows the organisation name in the why and the who lines', () => {
    render(<CameraConsent organisation="Acme College" busy={false} declined={false} {...handlers()} />);
    expect(screen.getByText(/Acme College asks for the camera/)).toBeTruthy();
    expect(screen.getByText(/only people at Acme College who review/)).toBeTruthy();
    expect(screen.getByText(/ask Acme College to show you/)).toBeTruthy();
  });

  it('falls back to "Your test organiser" when the organisation name is empty', () => {
    render(<CameraConsent organisation="" busy={false} declined={false} {...handlers()} />);
    expect(screen.getByText(/Your test organiser asks for the camera/)).toBeTruthy();
  });

  it('keeps the section 5 wording and the two buttons', () => {
    render(<CameraConsent organisation="Acme College" busy={false} declined={false} {...handlers()} />);
    expect(screen.getByText('This test uses your camera')).toBeTruthy();
    expect(screen.getByText(/We do not match your face to other pictures/)).toBeTruthy();
    expect(screen.getByText(/photos 90 days and video 7 days/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow camera and start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I do not agree, do not start' })).toBeTruthy();
  });

  it('links to the privacy notice and the DPA summary', () => {
    render(<CameraConsent organisation="Acme College" busy={false} declined={false} {...handlers()} />);
    expect(screen.getByRole('link', { name: 'privacy notice' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'AssessIQ DPA summary' }).getAttribute('href')).toBe('/dpa');
  });

  it('calls onAllow and onDecline from the two buttons', () => {
    const h = handlers();
    render(<CameraConsent organisation="Acme College" busy={false} declined={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow camera and start' }));
    fireEvent.click(screen.getByRole('button', { name: 'I do not agree, do not start' }));
    expect(h.onAllow).toHaveBeenCalledTimes(1);
    expect(h.onDecline).toHaveBeenCalledTimes(1);
  });

  it('declined: shows the message and only a way back', () => {
    const h = handlers();
    render(<CameraConsent organisation="Acme College" busy={false} declined={true} {...h} />);
    expect(
      screen.getByText(
        'You did not start the test. Contact your test organiser if you want to take it in another way.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow camera and start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'I do not agree, do not start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the start' }));
    expect(h.onBack).toHaveBeenCalledTimes(1);
  });
});
