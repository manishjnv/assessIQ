/**
 * @assessiq/embed — AssessIQ host-app SDK
 *
 * Provides:
 *   - `AssessIQEmbed.mount(selector, opts)` — mount an assessment iframe
 *   - `AssessIQEmbedUrl(opts)` — build the embed URL (for server-side use)
 *
 * Installation:
 *   npm install @assessiq/embed
 *
 * Usage (client-side, after minting a token server-side):
 *   ```html
 *   <div id="assessment-container" style="width:100%; height:600px;"></div>
 *   <script type="module">
 *     import { AssessIQEmbed } from '@assessiq/embed';
 *     const embed = AssessIQEmbed.mount('#assessment-container', {
 *       token: '<JWT from your server>',
 *       onReady: () => console.log('assessment loaded'),
 *       onSubmit: (e) => console.log('submitted', e),
 *     });
 *   </script>
 *   ```
 *
 * Server-side token minting:
 *   The token must be minted by your backend using the AssessIQ Admin API.
 *   See docs/03-api-contract.md § Embed for the /embed/sdk-mint endpoint.
 *   The token is single-use and expires in ≤ 600 seconds.
 *
 * Alternative (CDN):
 *   <script src="https://assessiq.automateedge.cloud/embed/sdk.js"></script>
 *   window.AssessIQ.mount('#container', opts);
 *
 * Security:
 *   - All cross-origin postMessages are validated against the configured
 *     allowedOrigins from your tenant settings.
 *   - Tokens are signed HS256, single-use (replay cache), and expire in ≤ 600s.
 *   - The iframe sets SameSite=None; Secure cookies automatically.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AssessIQEmbedOpts {
  /** JWT signed by your AssessIQ tenant's embed secret. Required. */
  token: string;

  /** Base URL of the AssessIQ deployment. Defaults to current origin. */
  baseUrl?: string;

  /** Called when the assessment iframe is loaded and the candidate session is active. */
  onReady?: (event: { type: 'aiq.ready'; version: string }) => void;

  /** Called when the candidate submits the assessment. */
  onSubmit?: (event: { type: 'aiq.attempt.submitted'; attemptId: string }) => void;

  /** Called on embed errors (expired token, invalid token, etc.). */
  onError?: (event: { type: 'aiq.error'; code: string; message: string }) => void;

  /** SDK version string forwarded to the server for analytics. */
  sdkVersion?: string;
}

export interface AssessIQEmbedInstance {
  /** The mounted iframe element. */
  iframe: HTMLIFrameElement;
  /** Unmount the iframe and remove the message listener. */
  destroy: () => void;
}

// ─── URL builder (server-safe — no DOM) ──────────────────────────────────────

/**
 * Build an embed entry URL for the given token and base URL.
 * Useful for server-side rendering or redirect flows.
 */
export function AssessIQEmbedUrl(opts: { token: string; baseUrl: string }): string {
  return `${opts.baseUrl}/embed?token=${encodeURIComponent(opts.token)}`;
}

// ─── AssessIQEmbed (browser only) ────────────────────────────────────────────

export const AssessIQEmbed = {
  /**
   * Mount an assessment iframe into the given container.
   *
   * @param container CSS selector string OR an existing HTMLElement
   * @param opts      Embed configuration options (token required)
   * @returns         { iframe, destroy } — call destroy() to clean up
   */
  mount(
    container: string | HTMLElement,
    opts: AssessIQEmbedOpts,
  ): AssessIQEmbedInstance {
    const el =
      typeof container === 'string'
        ? document.querySelector<HTMLElement>(container)
        : container;

    if (!el) {
      throw new Error(
        `AssessIQEmbed.mount: container element not found: ${String(container)}`,
      );
    }
    if (!opts.token) {
      throw new Error('AssessIQEmbed.mount: token is required');
    }

    const base =
      opts.baseUrl ??
      (typeof window !== 'undefined'
        ? `${window.location.protocol}//${window.location.host}`
        : '');

    const src =
      `${base}/embed?token=${encodeURIComponent(opts.token)}` +
      (opts.sdkVersion ? `&sdk_version=${encodeURIComponent(opts.sdkVersion)}` : '');

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    iframe.setAttribute('allow', 'fullscreen');
    iframe.setAttribute('title', 'AssessIQ Assessment');

    // Parse origin for postMessage filtering.
    let targetOrigin: string;
    try {
      targetOrigin = new URL(base).origin;
    } catch {
      targetOrigin = base;
    }

    function handleMessage(event: MessageEvent): void {
      if (event.origin !== targetOrigin) return;
      const data = event.data as { type?: string; [key: string]: unknown } | null;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'aiq.ready' && opts.onReady) {
        opts.onReady({ type: 'aiq.ready', version: String(data['version'] ?? '') });
      } else if (data.type === 'aiq.attempt.submitted' && opts.onSubmit) {
        opts.onSubmit({ type: 'aiq.attempt.submitted', attemptId: String(data['attemptId'] ?? '') });
      } else if (data.type === 'aiq.height' && typeof data['height'] === 'number') {
        iframe.style.height = `${data['height']}px`;
      } else if (data.type === 'aiq.error' && opts.onError) {
        opts.onError({
          type: 'aiq.error',
          code: String(data['code'] ?? 'UNKNOWN'),
          message: String(data['message'] ?? ''),
        });
      }
    }

    window.addEventListener('message', handleMessage);
    el.appendChild(iframe);

    return {
      iframe,
      destroy() {
        el.removeChild(iframe);
        window.removeEventListener('message', handleMessage);
      },
    };
  },
};
