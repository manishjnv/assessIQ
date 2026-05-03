/**
 * EmbedLayout
 *
 * Minimal shell for the candidate take UI when rendered inside a host iframe.
 *
 * Differences from normal layout:
 *   - No navigation bar / header
 *   - data-density="compact" → tighter spacing tokens
 *   - ResizeObserver → posts `aiq.height` so the host can auto-size the iframe
 *   - Sends `aiq.ready` on mount
 */
import { useEffect, useRef } from 'react';
import { send } from '../lib/embedBus';

interface EmbedLayoutProps {
  children: React.ReactNode;
}

export function EmbedLayout({ children }: EmbedLayoutProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Signal host that the embed is ready.
    send('aiq.ready', { version: '1.0.0' });

    // Auto-height: observe container resize and post new height.
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = Math.ceil(entry.contentRect.height);
        if (height > 0) {
          send('aiq.height', { height });
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-density="compact"
      data-embed="true"
      style={{ minHeight: '100vh', background: 'var(--aiq-color-bg-base, #fff)' }}
    >
      {children}
    </div>
  );
}
