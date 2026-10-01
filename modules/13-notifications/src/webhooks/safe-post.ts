/**
 * modules/13-notifications/src/webhooks/safe-post.ts
 *
 * The only place a webhook leaves the worker. A hardened HTTP POST on Node
 * core (`http`/`https`, no new dependency):
 *
 *   - URL policy re-checked on every delivery (url-policy.ts).
 *   - Address policy enforced at CONNECT time through a custom `lookup`: the
 *     hostname is resolved by the very call that opens the socket, ALL answers
 *     are checked, and any blocked answer refuses the delivery. Resolve-then-
 *     connect gaps (DNS rebinding) do not exist. IP-literal hosts never reach
 *     `lookup` (Node skips it), so they are checked by validateWebhookUrl.
 *   - Redirects are never followed (`http.request` has no redirect logic); the
 *     caller treats 3xx as a failed delivery.
 *   - One overall deadline (default 10 s) covers DNS + connect + TLS + response.
 *   - At most 2 KB of the response body is read; the connection is then dropped.
 *   - `agent: false`: a fresh socket per delivery — no pooling, no env proxy.
 *
 * NEVER log the full URL (webhook URLs routinely embed secrets in the path).
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { config } from '@assessiq/core';
import { isBlockedIp, validateWebhookUrl } from './url-policy.js';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 2048;

/** Why a delivery was refused. `blocked_address` = destination IP is not public. */
export type WebhookRefusalReason = 'blocked_address' | 'blocked_url';

/** The SSRF guard said no. Permanent: the caller must NOT retry. */
export class WebhookRefusedError extends Error {
  readonly reason: WebhookRefusalReason;
  readonly host: string | undefined;
  /** The offending resolved address (operator logs only — never stored for tenants). */
  readonly address: string | undefined;

  constructor(reason: WebhookRefusalReason, detail: { host?: string; address?: string } = {}) {
    super(`webhook delivery refused: ${reason}`);
    this.name = 'WebhookRefusedError';
    this.reason = reason;
    this.host = detail.host;
    this.address = detail.address;
  }
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookResponse {
  status: number;
  /** First <= 2 KB of the response body, UTF-8 decoded. */
  bodySnippet: string;
}

/** Injection seams. Production passes nothing; tests inject. */
export interface PostDeps {
  /** Address policy. Default isBlockedIp. Tests pass `() => false` to reach a loopback fixture. */
  isBlocked?: (ip: string) => boolean;
  /** DNS resolver. Default dns.lookup. Tests inject a fake to simulate private/rebinding answers. */
  resolver?: typeof dns.lookup;
  timeoutMs?: number;
}

/**
 * A `lookup` for http(s).request that refuses when ANY resolved address is
 * blocked (a mixed public+private answer set is the classic rebinding trick).
 */
export function guardedLookup(
  isBlocked: (ip: string) => boolean = isBlockedIp,
  resolver: typeof dns.lookup = dns.lookup,
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '');
        return;
      }
      const bad = addresses.find((a) => isBlocked(a.address));
      if (bad !== undefined || addresses.length === 0) {
        callback(new WebhookRefusedError('blocked_address', { host: hostname, ...(bad ? { address: bad.address } : {}) }), '');
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
      } else {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

export function postWebhook(req: WebhookRequest, deps: PostDeps = {}): Promise<WebhookResponse> {
  const isBlocked = deps.isBlocked ?? isBlockedIp;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  const checked = validateWebhookUrl(req.url, {
    allowHttp: config.NODE_ENV !== 'production',
    isBlocked,
  });
  if (!checked.ok) {
    return Promise.reject(
      new WebhookRefusedError(checked.reason === 'blocked_address' ? 'blocked_address' : 'blocked_url'),
    );
  }
  const url = checked.url;
  const secure = url.protocol === 'https:';
  const client = secure ? https : http;

  return new Promise<WebhookResponse>((resolve, reject) => {
    const request = client.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...req.headers, 'Content-Length': String(Buffer.byteLength(req.body)) },
        agent: false,
        lookup: guardedLookup(isBlocked, deps.resolver),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            bodySnippet: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (size < WEBHOOK_MAX_RESPONSE_BYTES) {
            chunks.push(chunk.subarray(0, WEBHOOK_MAX_RESPONSE_BYTES - size));
          }
          size += chunk.length;
          if (size >= WEBHOOK_MAX_RESPONSE_BYTES) {
            finish();
            res.destroy(); // hostile endpoint: stop reading, drop the connection
          }
        });
        res.once('end', finish);
        // Body cut short (timeout / reset): the status line already decides the outcome.
        res.once('error', finish);
        res.once('close', finish);
      },
    );
    request.once('error', (err: Error) => {
      reject(err.name === 'AbortError' ? new Error(`webhook request timed out after ${timeoutMs}ms`) : err);
    });
    request.end(req.body);
  });
}
