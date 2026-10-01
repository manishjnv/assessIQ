/**
 * modules/13-notifications/src/webhooks/url-policy.ts
 *
 * Pure SSRF policy for tenant-registered webhook endpoints: which URLs and
 * which IP addresses a delivery may talk to. No I/O in this file.
 *
 *   - validateWebhookUrl: parse + scheme + userinfo + localhost + IP-literal
 *     rules. Runs at create time (fast 400) and again at delivery time (rows
 *     that pre-date the policy are re-checked, never trusted).
 *   - isBlockedIp: the address policy. safe-post.ts applies it at CONNECT time
 *     (custom `lookup`), which is the real guard — DNS rebinding between a
 *     check and the connect cannot bypass it.
 *
 * The worker runs on a shared VPS next to other apps and our own Postgres and
 * Redis, so the policy is "deliver to the public internet only".
 *
 * IPv4: deny-list of the IANA special-purpose blocks.
 * IPv6: allow-list — only global unicast 2000::/3 minus special carve-outs is
 * allowed, so every other range (loopback, unspecified, ULA, link-local,
 * multicast, IPv4-compatible, reserved space) is blocked by default.
 * IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) addresses are judged by
 * the IPv4 address they embed.
 */

import { isIP } from 'node:net';

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/** [network, prefix length] — blocked IPv4 blocks. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], //        "this network" incl. 0.0.0.0 (unspecified)
  ['10.0.0.0', 8], //       private
  ['100.64.0.0', 10], //    CGNAT (RFC 6598)
  ['127.0.0.0', 8], //      loopback
  ['169.254.0.0', 16], //   link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], //    private
  ['192.0.0.0', 24], //     IETF protocol assignments
  ['192.0.2.0', 24], //     TEST-NET-1
  ['192.88.99.0', 24], //   6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], //   private
  ['198.18.0.0', 15], //    benchmarking
  ['198.51.100.0', 24], //  TEST-NET-2
  ['203.0.113.0', 24], //   TEST-NET-3
  ['224.0.0.0', 4], //      multicast
  ['240.0.0.0', 4], //      reserved + 255.255.255.255 (broadcast)
];

/** Dotted quad -> unsigned 32-bit number, or null when it is not a dotted quad. */
function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

const V4_TABLE: ReadonlyArray<readonly [number, number]> = V4_BLOCKED.map(
  ([net, len]) => [v4ToInt(net) as number, len] as const,
);

function isBlockedV4(n: number): boolean {
  return V4_TABLE.some(([base, len]) => n >>> (32 - len) === base >>> (32 - len));
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/** Validated IPv6 string -> eight 16-bit groups, or null if it cannot be parsed. */
function parseV6(ip: string): number[] | null {
  let s = ip;
  // Embedded IPv4 tail (::ffff:1.2.3.4) -> two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = v4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isBlockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embeddedV4 = (g6 * 65536 + g7) >>> 0;
  const zeroThrough4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // IPv4-mapped ::ffff:0:0/96 — the kernel connects to the embedded IPv4 address.
  if (zeroThrough4 && g5 === 0xffff) return isBlockedV4(embeddedV4);
  // NAT64 well-known prefix 64:ff9b::/96 — a gateway translates to the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(embeddedV4);
  }

  // Everything outside global unicast 2000::/3 is blocked: ::/128 unspecified,
  // ::1 loopback, ::/96 IPv4-compatible, fc00::/7 ULA, fe80::/10 link-local,
  // fec0::/10 site-local, ff00::/8 multicast, 64:ff9b:1::/48 local NAT64, ...
  if ((g0 & 0xe000) !== 0x2000) return true;

  // Special-purpose carve-outs inside 2000::/3.
  if (g0 === 0x2001 && g1 < 0x0200) return true; //          2001::/23  IETF protocol (Teredo, benchmarking, ORCHID)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; //        2001:db8::/32 documentation
  if (g0 === 0x2002) return true; //                         2002::/16  6to4 (embeds IPv4, deprecated)
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true; //  3fff::/20  documentation
  return false;
}

// ---------------------------------------------------------------------------
// Public: address policy
// ---------------------------------------------------------------------------

/**
 * True when `ip` must never be a webhook destination. Fails closed: anything
 * that is not a parseable IP literal is reported as blocked.
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.split('%')[0] ?? ''; // IPv6 zone id (fe80::1%eth0)
  const family = isIP(addr);
  if (family === 4) {
    const n = v4ToInt(addr);
    return n === null || isBlockedV4(n);
  }
  if (family === 6) {
    const groups = parseV6(addr);
    return groups === null || isBlockedV6(groups);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public: URL policy
// ---------------------------------------------------------------------------

export type WebhookUrlRejection =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'userinfo_not_allowed'
  | 'localhost_not_allowed'
  | 'blocked_address';

export type WebhookUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: WebhookUrlRejection };

export interface WebhookUrlOptions {
  /** Allow `http:` (local development / tests only). Default false: https only. */
  allowHttp?: boolean;
  /** Address policy; defaults to isBlockedIp. Tests only. */
  isBlocked?: (ip: string) => boolean;
}

/**
 * Parse + policy-check a webhook URL. Pure: no DNS. Hostnames that merely
 * RESOLVE to a blocked address pass here and are refused at connect time.
 *
 * The WHATWG parser normalizes decimal/hex/octal IPv4 spellings
 * (http://2130706433/, http://0x7f.1/) to dotted quads before we look at them.
 */
export function validateWebhookUrl(raw: string, opts: WebhookUrlOptions = {}): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp === true && url.protocol === 'http:')) {
    return { ok: false, reason: 'scheme_not_allowed' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  const host = bareHostname(url);
  if (host === '') return { ok: false, reason: 'invalid_url' };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost_not_allowed' };
  }
  if (isIP(host) !== 0 && (opts.isBlocked ?? isBlockedIp)(host)) {
    return { ok: false, reason: 'blocked_address' };
  }
  return { ok: true, url };
}

/** Lower-case hostname without IPv6 brackets or a trailing root dot. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}
