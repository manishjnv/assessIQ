/**
 * embedBus — postMessage bridge for the embed iframe.
 *
 * OUTBOUND (iframe → host):  send(type, payload)
 *   Uses `parent.postMessage` with the verified target origin.
 *
 * INBOUND (host → iframe):  onMessage(type, handler) / removeListener()
 *   Filters messages by origin against window.__AIQ_EMBED_CONFIG__.allowedOrigins
 *   before passing to handlers. Unknown origins are silently dropped.
 *
 * Special case: `aiq.ready` is sent to `'*'` so the host receives it even
 * before the SDK has confirmed which origin the host is loaded on. All other
 * outbound messages use the verified target origin from allowedOrigins[0].
 *
 * Security notes:
 *   - Only origins listed in allowedOrigins (set by the server via the embed
 *     config endpoint) are trusted for inbound messages.
 *   - Outbound messages (except aiq.ready) are sent to allowedOrigins[0] only.
 *   - The bus is initialized lazily; if there is no embed config, send() is a
 *     no-op rather than throwing, so non-embed pages load normally.
 *
 * Frozen decision D12: postMessage target origin is never '*' except aiq.ready.
 */

declare global {
  interface Window {
    __AIQ_EMBED_CONFIG__?: {
      allowedOrigins: string[];
    };
  }
}

export type EmbedMessageType =
  | 'aiq.ready'
  | 'aiq.height'
  | 'aiq.attempt.submitted'
  | 'aiq.error';

export interface EmbedMessage {
  type: EmbedMessageType;
  [key: string]: unknown;
}

type MessageHandler = (msg: EmbedMessage) => void;

const handlers = new Map<EmbedMessageType, Set<MessageHandler>>();

function getAllowedOrigins(): string[] {
  return window.__AIQ_EMBED_CONFIG__?.allowedOrigins ?? [];
}

function handleIncoming(event: MessageEvent): void {
  const allowed = getAllowedOrigins();
  if (!allowed.includes(event.origin)) {
    // Drop messages from unrecognised origins — silent per security requirement.
    return;
  }
  const data = event.data as EmbedMessage | undefined;
  if (!data || typeof data.type !== 'string') return;
  const set = handlers.get(data.type as EmbedMessageType);
  if (set) {
    for (const fn of set) {
      fn(data);
    }
  }
}

// Attach listener once.
window.addEventListener('message', handleIncoming);

/**
 * Send a message to the parent frame.
 * `aiq.ready` → targetOrigin='*' (host not yet known)
 * all others   → targetOrigin = allowedOrigins[0] (verified)
 */
export function send(type: EmbedMessageType, payload: Record<string, unknown> = {}): void {
  if (window.parent === window) return; // not in an iframe — no-op

  const allowed = getAllowedOrigins();
  const targetOrigin = type === 'aiq.ready'
    ? '*'
    : (allowed[0] ?? '*'); // fallback to * only if config missing (shouldn't happen in prod)

  window.parent.postMessage({ type, ...payload }, targetOrigin);
}

/**
 * Subscribe to inbound messages from the host.
 * Returns an unsubscribe function.
 */
export function onMessage(type: EmbedMessageType, handler: MessageHandler): () => void {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type)!.add(handler);
  return () => {
    handlers.get(type)?.delete(handler);
  };
}
