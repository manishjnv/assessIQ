/**
 * modules/13-notifications/src/__tests__/webhook-safety.test.ts
 *
 * Smoke tests for webhook SSRF safety + replay-safe signing (2026-10-01):
 *   A. isBlockedIp — IPv4 + IPv6 incl. mapped / compatible / NAT64
 *   B. validateWebhookUrl — scheme, userinfo, localhost, IP literals
 *   C. createWebhookEndpoint rejects http://127.0.0.1/x and https://10.0.0.5/x
 *   D. delivery guard — private answer refused at CONNECT time (fake resolver),
 *      not retried; redirects not followed; V2 signature verifies; 2 KB body cap;
 *      timeout.
 *
 * Loopback fixture servers need the guard off: that is the `isBlocked: () => false`
 * test seam of processWebhookDeliverJob / postWebhook (never reachable from config).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@assessiq/core', () => {
  class AppError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details: Record<string, unknown> | undefined;
    constructor(message: string, code: string, status: number, opts?: { details?: Record<string, unknown> }) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = opts?.details;
    }
  }
  return {
    config: {
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      ASSESSIQ_MASTER_KEY: Buffer.alloc(32).toString('base64'),
    },
    streamLogger: () => mockLog,
    uuidv7: () => 'test-uuid',
    AppError,
  };
});

vi.mock('@assessiq/audit-log', () => ({ auditInTx: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn().mockResolvedValue({}) })),
}));
vi.mock('ioredis', () => ({ Redis: vi.fn().mockImplementation(() => ({})) }));

vi.mock('../repository.js', () => ({
  insertWebhookEndpoint: vi.fn().mockImplementation((_c: unknown, input: { id: string; url: string }) => ({
    id: input.id,
    url: input.url,
  })),
  getWebhookDeliveryById: vi.fn(),
  getWebhookEndpointById: vi.fn(),
  updateWebhookDeliveryStatus: vi.fn().mockResolvedValue(undefined),
}));

import { config } from '@assessiq/core';
import * as repo from '../repository.js';
import * as service from '../webhooks/service.js';
import { isBlockedIp, validateWebhookUrl } from '../webhooks/url-policy.js';
import { guardedLookup } from '../webhooks/safe-post.js';
import { processWebhookDeliverJob } from '../webhooks/deliver-job.js';
import { signPayload, signPayloadV2, verifySignatureV2 } from '../webhooks/signature.js';

// ---------------------------------------------------------------------------
// A. IP-range checker
// ---------------------------------------------------------------------------

describe('isBlockedIp — IPv4', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.5', '10.255.255.255', '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.5', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '9.255.255.255', '11.0.0.1', '100.63.255.255',
    '100.128.0.1', '126.255.255.255', '128.0.0.1', '169.253.1.1', '169.255.0.1', '172.15.255.255',
    '172.32.0.1', '192.167.255.255', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255',
  ];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('isBlockedIp — IPv6', () => {
  const blocked = [
    '::', '::1', '0:0:0:0:0:0:0:1',
    // IPv4-mapped of blocked v4
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:a00:5', '::ffff:169.254.169.254',
    // IPv4-compatible (deprecated) — whole ::/96
    '::127.0.0.1', '::a00:5', '::8.8.8.8',
    // NAT64 well-known prefix of blocked v4 + local-use NAT64
    '64:ff9b::7f00:1', '64:ff9b::10.0.0.5', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1',
    // ULA, link-local (+ zone id), site-local, multicast
    'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    // reserved / special-purpose inside and outside 2000::/3
    '2001:db8::1', '2001::1', '2002:a00:5::1', '2002:808:808::1', '100::1', '3fff::1', '5f00::1', '4000::1',
  ];
  const allowed = [
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e',
    // mapped / NAT64 of PUBLIC v4 are judged as that v4
    '::ffff:8.8.8.8', '64:ff9b::808:808',
  ];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
  it('fails closed on garbage', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. URL policy
// ---------------------------------------------------------------------------

describe('validateWebhookUrl', () => {
  const reason = (u: string, allowHttp = false): string | 'ok' => {
    const r = validateWebhookUrl(u, { allowHttp });
    return r.ok ? 'ok' : r.reason;
  };

  it('accepts public https URLs (hostname, public v4 and v6 literals)', () => {
    expect(reason('https://hooks.example.com/a?b=1')).toBe('ok');
    expect(reason('https://93.184.216.34/x')).toBe('ok');
    expect(reason('https://[2606:4700:4700::1111]/x')).toBe('ok');
  });

  it('is https-only; http only when allowHttp', () => {
    expect(reason('http://example.com/x')).toBe('scheme_not_allowed');
    expect(reason('http://example.com/x', true)).toBe('ok');
    expect(reason('ftp://example.com/x', true)).toBe('scheme_not_allowed');
    expect(reason('javascript:alert(1)', true)).toBe('scheme_not_allowed');
    expect(reason('not a url')).toBe('invalid_url');
  });

  it('rejects userinfo', () => {
    expect(reason('https://user:pw@example.com/x')).toBe('userinfo_not_allowed');
    expect(reason('https://user@example.com/x')).toBe('userinfo_not_allowed');
  });

  it('rejects localhost spellings', () => {
    expect(reason('https://localhost/x')).toBe('localhost_not_allowed');
    expect(reason('https://LOCALHOST./x')).toBe('localhost_not_allowed');
    expect(reason('https://app.localhost/x')).toBe('localhost_not_allowed');
  });

  it('rejects blocked IP literals, including alternative spellings', () => {
    for (const u of [
      'https://10.0.0.5/x',
      'http://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[fd00::1]/x',
      'https://2130706433/x', //  decimal 127.0.0.1
      'https://0x7f.1/x', //      hex + short form of 127.0.0.1
      'https://0177.0.0.1/x', //  octal 127.0.0.1
    ]) {
      expect(reason(u, true), u).toBe('blocked_address');
    }
  });
});

// ---------------------------------------------------------------------------
// C. create-time rejection
// ---------------------------------------------------------------------------

describe('createWebhookEndpoint — URL policy', () => {
  const create = (url: string) =>
    service.createWebhookEndpoint({
      tenantId: 'tenant-1',
      name: 'Hook',
      url,
      events: ['attempt.graded'],
      requiresFreshMfa: false,
    });

  beforeEach(() => {
    vi.mocked(repo.insertWebhookEndpoint).mockClear();
  });

  it.each(['http://127.0.0.1/x', 'https://10.0.0.5/x'])(
    'rejects %s with 400 WEBHOOK_URL_NOT_ALLOWED and writes nothing',
    async (url) => {
      await expect(create(url)).rejects.toMatchObject({
        code: 'WEBHOOK_URL_NOT_ALLOWED',
        status: 400,
        details: { reason: 'blocked_address' },
      });
      expect(repo.insertWebhookEndpoint).not.toHaveBeenCalled();
    },
  );

  it('rejects http:// in production, accepts a public https URL', async () => {
    const env = config as { NODE_ENV: string };
    env.NODE_ENV = 'production';
    try {
      await expect(create('http://example.com/x')).rejects.toMatchObject({
        code: 'WEBHOOK_URL_NOT_ALLOWED',
        details: { reason: 'scheme_not_allowed' },
      });
    } finally {
      env.NODE_ENV = 'test';
    }
    await expect(create('https://hooks.example.com/x')).resolves.toBeDefined();
    expect(repo.insertWebhookEndpoint).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// D. delivery guard
// ---------------------------------------------------------------------------

const SECRET = 'whsec-test-secret';

function job(deliveryId: string): never {
  return { data: { deliveryId, tenantId: 'tenant-1' }, attemptsMade: 0 } as never;
}

function stubDelivery(deliveryId: string, url: string, payload: unknown = { hello: 'world', n: 1 }): void {
  vi.mocked(repo.getWebhookDeliveryById).mockResolvedValue({
    id: deliveryId,
    endpoint_id: 'ep-1',
    event: 'attempt.graded',
    payload,
    status: 'pending',
    http_status: null,
    attempts: 0,
    retry_at: null,
    delivered_at: null,
    last_error: null,
    created_at: new Date(),
  });
  vi.mocked(repo.getWebhookEndpointById).mockResolvedValue({
    id: 'ep-1',
    tenant_id: 'tenant-1',
    name: 'Hook',
    url,
    events: ['attempt.graded'],
    status: 'active',
    requires_fresh_mfa: false,
    created_at: new Date(),
  });
  vi.spyOn(service, 'getDecryptedSecret').mockResolvedValue(SECRET);
}

/** The status row written by the delivery job (the last updateWebhookDeliveryStatus call). */
function lastUpdate(): Record<string, unknown> {
  const calls = vi.mocked(repo.updateWebhookDeliveryStatus).mock.calls;
  return calls[calls.length - 1]![2] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(repo.updateWebhookDeliveryStatus).mockClear();
  mockLog.warn.mockClear();
});

describe('delivery guard — refused deliveries', () => {
  const resolverTo = (...addresses: string[]) =>
    vi.fn((_host: string, _opts: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))),
    );

  it('hostname resolving to a private IP is refused at connect time, recorded failed, NOT retried', async () => {
    const resolver = resolverTo('10.0.0.5');
    stubDelivery('del-priv', 'https://hooks.example.test/s3cr3t-path?token=abc');

    // Resolves (does not throw) => BullMQ sees a completed job => no retry.
    const result = await processWebhookDeliverJob(job('del-priv'), {
      resolver: resolver as never,
      timeoutMs: 1000,
    });

    expect(result).toEqual({ deliveryId: 'del-priv', status: 'failed', httpStatus: null });
    // The URL policy passes a name; the refusal came from the lookup that opens the socket.
    expect(resolver).toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'failed', lastError: 'blocked_address' });
    // Operator log carries the reason, never the URL path/query (often a secret).
    expect(JSON.stringify(mockLog.warn.mock.calls)).toContain('webhook.delivery.refused');
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('s3cr3t-path');
  });

  it('ANY blocked address in the answer set refuses (public + private mix)', async () => {
    stubDelivery('del-mix', 'https://hooks.example.test/x');
    const result = await processWebhookDeliverJob(job('del-mix'), {
      resolver: resolverTo('93.184.216.34', '169.254.169.254') as never,
      timeoutMs: 1000,
    });
    expect(result.status).toBe('failed');
    expect(lastUpdate()).toMatchObject({ lastError: 'blocked_address' });
  });

  it('every connect re-checks: a rebinding answer on the 2nd lookup is refused', async () => {
    let calls = 0;
    const rebinding = vi.fn((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
      cb(null, [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]),
    );
    const lookup = guardedLookup(isBlockedIp, rebinding as never);
    const first = vi.fn();
    const second = vi.fn();
    lookup('rebind.example.test', { all: true }, first);
    lookup('rebind.example.test', { all: true }, second);
    expect(first).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(second.mock.calls[0]![0]).toMatchObject({ name: 'WebhookRefusedError', reason: 'blocked_address' });
  });

  it('IP-literal and policy-violating URLs on legacy rows are refused (blocked_address / blocked_url)', async () => {
    stubDelivery('del-lit', 'https://10.0.0.5/x');
    await processWebhookDeliverJob(job('del-lit'));
    expect(lastUpdate()).toMatchObject({ status: 'failed', lastError: 'blocked_address' });

    stubDelivery('del-scheme', 'ftp://example.com/x');
    await processWebhookDeliverJob(job('del-scheme'));
    expect(lastUpdate()).toMatchObject({ status: 'failed', lastError: 'blocked_url' });
  });
});

describe('delivery guard — HTTP behaviour against a loopback fixture', () => {
  const open: Server[] = [];
  const seam = { isBlocked: () => false };

  async function listen(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<string> {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => handler(req, body, res));
    });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    for (const s of open.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('redirects are NOT followed: 3xx is a permanent failed delivery and the target is never hit', async () => {
    let targetHits = 0;
    const target = await listen((_req, _body, res) => {
      targetHits++;
      res.end('hit');
    });
    const redirector = await listen((_req, _body, res) => {
      res.writeHead(302, { Location: `${target}/hit` });
      res.end();
    });
    stubDelivery('del-redir', `${redirector}/hook`);

    const result = await processWebhookDeliverJob(job('del-redir'), seam);

    expect(result).toEqual({ deliveryId: 'del-redir', status: 'failed', httpStatus: 302 });
    expect(targetHits).toBe(0);
    expect(lastUpdate()).toMatchObject({ status: 'failed', httpStatus: 302 });
    expect(String(lastUpdate()['lastError'])).toContain('redirects are not followed');
  });

  it('sends X-AssessIQ-Timestamp (unix seconds) + a V2 signature that verifies; V1 header unchanged', async () => {
    let seen: { headers: IncomingMessage['headers']; body: string } | undefined;
    const url = await listen((req, body, res) => {
      seen = { headers: req.headers, body };
      res.writeHead(200);
      res.end('ok');
    });
    const payload = { event: 'attempt.graded', attempt_id: 'att_1', note: 'héllo ✓' };
    stubDelivery('del-sig', `${url}/hook`, payload);

    const result = await processWebhookDeliverJob(job('del-sig'), seam);
    expect(result).toMatchObject({ status: 'delivered', httpStatus: 200 });

    const h = seen!.headers;
    const body = seen!.body;
    const ts = h['x-assessiq-timestamp'] as string;
    const sigV2 = h['x-assessiq-signature-v2'] as string;

    expect(JSON.parse(body)).toEqual(payload);
    expect(h['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(ts).toMatch(/^\d{10}$/);
    expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(5);
    // V1 unchanged: body-only HMAC.
    expect(h['x-assessiq-signature']).toBe(signPayload(body, SECRET));
    // V2: HMAC over "<timestamp>.<raw body>", computed independently here.
    expect(sigV2).toBe(`sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')}`);
    expect(verifySignatureV2(body, SECRET, ts, sigV2)).toBe(true);
    // Replay / tamper protection.
    expect(verifySignatureV2(body, SECRET, String(Number(ts) - 1), sigV2)).toBe(false);
    expect(verifySignatureV2(body + ' ', SECRET, ts, sigV2)).toBe(false);
    expect(verifySignatureV2(body, 'other-secret', ts, sigV2)).toBe(false);
    expect(verifySignatureV2(body, SECRET, ts, sigV2, { nowSec: Number(ts) + 301 })).toBe(false); // > 5 min old
    expect(verifySignatureV2(body, SECRET, ts, sigV2, { nowSec: Number(ts) + 299 })).toBe(true);
    expect(verifySignatureV2(body, SECRET, 'not-a-number', sigV2)).toBe(false);
  });

  it('signPayloadV2 is the documented MAC', () => {
    const mac = createHmac('sha256', 's').update('1700000000.{"a":1}', 'utf8').digest('hex');
    expect(signPayloadV2('{"a":1}', 's', '1700000000')).toBe(`sha256=${mac}`);
  });

  it('4xx stores a capped, control-char-free response snippet and is permanent', async () => {
    const url = await listen((_req, _body, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`bad\u0000request ${'x'.repeat(10_000)}`);
    });
    stubDelivery('del-4xx', `${url}/hook`);

    const result = await processWebhookDeliverJob(job('del-4xx'), seam);

    expect(result).toMatchObject({ status: 'failed', httpStatus: 400 });
    const lastError = String(lastUpdate()['lastError']);
    expect(lastError.startsWith('HTTP 400: bad request ')).toBe(true);
    expect(lastError).not.toContain('\u0000');
    expect(lastError.length).toBeLessThanOrEqual(2048 + 'HTTP 400: '.length);
  });

  it('5xx throws so BullMQ retries; a hung endpoint times out (and throws) instead of blocking the worker', async () => {
    const down = await listen((_req, _body, res) => {
      res.writeHead(503);
      res.end();
    });
    stubDelivery('del-5xx', `${down}/hook`);
    await expect(processWebhookDeliverJob(job('del-5xx'), seam)).rejects.toThrow(/Transient HTTP 503/);

    const hung = await listen(() => {
      /* never answers */
    });
    stubDelivery('del-hung', `${hung}/hook`);
    await expect(
      processWebhookDeliverJob(job('del-hung'), { ...seam, timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});
