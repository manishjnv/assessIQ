// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssessIQEmbed } from '../index.js';

const BASE = 'https://assessiq.example';

function post(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { origin, data }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function setup() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

describe('AssessIQEmbed.mount', () => {
  it('creates the iframe with the token in the URL', () => {
    const host = setup();
    const { iframe } = AssessIQEmbed.mount(host, { token: 'a b', baseUrl: BASE });
    expect(host.contains(iframe)).toBe(true);
    expect(iframe.src).toBe(`${BASE}/embed?token=a%20b`);
  });

  it('throws without a token or container', () => {
    const host = setup();
    expect(() => AssessIQEmbed.mount(host, { token: '', baseUrl: BASE })).toThrow(/token/);
    expect(() => AssessIQEmbed.mount('#nope', { token: 't', baseUrl: BASE })).toThrow(/not found/);
  });

  it('ignores messages from a wrong origin', () => {
    const onSubmit = vi.fn();
    AssessIQEmbed.mount(setup(), { token: 't', baseUrl: BASE, onSubmit });
    post('https://evil.example', { type: 'aiq.attempt.submitted', attemptId: 'x' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onReady, onSubmit, onError and resizes on aiq.height', () => {
    const onReady = vi.fn();
    const onSubmit = vi.fn();
    const onError = vi.fn();
    const { iframe } = AssessIQEmbed.mount(setup(), { token: 't', baseUrl: BASE, onReady, onSubmit, onError });
    post(BASE, { type: 'aiq.ready', version: '1' });
    post(BASE, { type: 'aiq.attempt.submitted', attemptId: 'att1' });
    post(BASE, { type: 'aiq.error', code: 'E', message: 'm' });
    post(BASE, { type: 'aiq.height', height: 640 });
    expect(onReady).toHaveBeenCalledWith({ type: 'aiq.ready', version: '1' });
    expect(onSubmit).toHaveBeenCalledWith({ type: 'aiq.attempt.submitted', attemptId: 'att1' });
    expect(onError).toHaveBeenCalledWith({ type: 'aiq.error', code: 'E', message: 'm' });
    expect(iframe.style.height).toBe('640px');
  });

  it('destroy removes the iframe and the listener', () => {
    const onSubmit = vi.fn();
    const host = setup();
    const { iframe, destroy } = AssessIQEmbed.mount(host, { token: 't', baseUrl: BASE, onSubmit });
    destroy();
    expect(host.contains(iframe)).toBe(false);
    post(BASE, { type: 'aiq.attempt.submitted', attemptId: 'x' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('onBlocked fires when aiq.ready does not arrive; not after ready or destroy', () => {
    vi.useFakeTimers();
    const blocked = vi.fn();
    AssessIQEmbed.mount(setup(), { token: 't', baseUrl: BASE, onBlocked: blocked, readyTimeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(blocked).toHaveBeenCalledTimes(1);

    const b2 = vi.fn();
    AssessIQEmbed.mount(setup(), { token: 't', baseUrl: BASE, onBlocked: b2, readyTimeoutMs: 1000 });
    post(BASE, { type: 'aiq.ready', version: '1' });
    vi.advanceTimersByTime(2000);
    expect(b2).not.toHaveBeenCalled();

    const b3 = vi.fn();
    AssessIQEmbed.mount(setup(), { token: 't', baseUrl: BASE, onBlocked: b3 }).destroy();
    vi.advanceTimersByTime(20_000);
    expect(b3).not.toHaveBeenCalled();
  });
});
