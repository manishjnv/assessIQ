/** Z-154: ReadinessPanel with the camera off (camera={null} in state) shows no camera row and no Begin button. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReadinessPanel, type ReadinessState } from './ReadinessPanel';

afterEach(() => cleanup());

const state: ReadinessState = {
  rows: [
    { id: 'device', label: 'Laptop or desktop', status: 'ok' },
    { id: 'screen', label: 'Screen size', status: 'ok' },
    { id: 'browser', label: 'Browser (chrome 124)', status: 'ok' },
    { id: 'network', label: 'Internet speed', status: 'ok' },
  ],
  running: false,
  passed: true,
  device: null,
  signals: null,
  camera: null,
  retry: vi.fn(),
};

describe('ReadinessPanel with the camera off', () => {
  it('lists the device rows and no camera row', () => {
    render(<ReadinessPanel state={state} optional={false} />);
    expect(screen.getByText('Screen size')).toBeTruthy();
    expect(screen.queryByText('Camera')).toBeNull();
    expect(screen.queryByRole('button', { name: /check camera/i })).toBeNull();
  });

  it('renders no Begin button', () => {
    render(<ReadinessPanel state={state} optional={false} />);
    expect(screen.queryByRole('button', { name: /begin/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
