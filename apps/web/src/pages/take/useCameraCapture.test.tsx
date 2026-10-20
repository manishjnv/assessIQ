// Camera capture hook: gate, photo interval, video on track end, retry, denied.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCameraCapture } from './useCameraCapture.js';

type Handler = () => void;
let track: { addEventListener: (n: string, h: Handler) => void; fire: (n: string) => void; stop: () => void };
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function makeTrack(): typeof track {
  const hs: Record<string, Handler[]> = {};
  return {
    addEventListener: (n, h) => { (hs[n] ??= []).push(h); },
    fire: (n) => { (hs[n] ?? []).forEach((h) => h()); },
    stop: vi.fn(),
  };
}

class FakeRecorder {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'.repeat(100)]) });
    this.onstop?.();
  }
}

function status(over: Record<string, unknown> = {}): void {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/camera/status')
        ? { ok: true, status: 200, json: () => Promise.resolve({ required: true, photos: true, video: true, photoIntervalSeconds: 30, noticeVersion: 'v1', ...over }) }
        : { ok: true, status: 201, json: () => Promise.resolve({ id: 'x' }) },
    ),
  );
}

const uploads = (kind: string): unknown[][] =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(`/camera/${kind}`));
const flush = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

beforeEach(() => {
  vi.useFakeTimers();
  track = makeTrack();
  getUserMedia = vi.fn(() => Promise.resolve({ getVideoTracks: () => [track], getTracks: () => [track] }));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: (b: Blob) => void) => cb(new Blob(['j'.repeat(50)]))) as never;
  status();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useCameraCapture', () => {
  it('does nothing when the camera is not required', async () => {
    status({ required: false });
    const { result } = renderHook(() => useCameraCapture('a1', { active: true }));
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe('off');
  });

  it('posts a photo after the first delay', async () => {
    const { result } = renderHook(() => useCameraCapture('a1', { active: true }));
    await flush();
    expect(result.current.state).toBe('on');
    expect(getUserMedia).toHaveBeenCalledWith({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(uploads('photo')).toHaveLength(1);
  });

  it('school photos off: no photo, video still uploads on track end', async () => {
    status({ photos: false });
    const { result } = renderHook(() => useCameraCapture('a1', { active: true }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(uploads('photo')).toHaveLength(0);
    act(() => track.fire('ended'));
    expect(result.current.state).toBe('lost');
    expect(uploads('video')).toHaveLength(1);
    expect(String(uploads('video')[0]![0])).toContain('reason=camera_stopped');
  });

  it('track ended: lost, one video; Retry restores on', async () => {
    const { result } = renderHook(() => useCameraCapture('a1', { active: true }));
    await flush();
    act(() => track.fire('ended'));
    act(() => track.fire('mute')); // same incident: no second upload
    expect(result.current.state).toBe('lost');
    expect(uploads('video')).toHaveLength(1);
    act(() => result.current.retry());
    await flush();
    expect(result.current.state).toBe('on');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('denied permission gives state denied', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    const { result } = renderHook(() => useCameraCapture('a1', { active: true }));
    await flush();
    expect(result.current.state).toBe('denied');
  });
});
