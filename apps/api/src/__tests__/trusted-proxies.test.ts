import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { TRUSTED_PROXIES, TRUSTED_GATEWAY, warnIfGatewayOutsideOwnNetwork } from '../trusted-proxies.js';

const rangesFile = fileURLToPath(new URL('../../../../infra/caddyfile/cloudflare-ranges.txt', import.meta.url));

async function ipFor(remoteAddress: string, xff?: string): Promise<string> {
  const app = Fastify({ logger: false, trustProxy: TRUSTED_PROXIES });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('TRUSTED_PROXIES (A1-7)', () => {
  it('equals the gateway plus infra/caddyfile/cloudflare-ranges.txt', () => {
    const file = readFileSync(rangesFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(file).toHaveLength(22);
    expect(TRUSTED_PROXIES.filter((p) => p !== TRUSTED_GATEWAY).sort()).toEqual([...file].sort());
    expect(TRUSTED_PROXIES).not.toContain('172.16.0.0/12');
  });

  it('(a) gateway peer: first untrusted hop from the right wins', async () => {
    expect(await ipFor('172.21.0.1', '9.9.9.9, 203.0.113.7, 162.158.1.1')).toBe('203.0.113.7');
  });

  it('(b) untrusted peer with forged XFF: peer wins', async () => {
    expect(await ipFor('198.51.100.5', '9.9.9.9, 1.2.3.4')).toBe('198.51.100.5');
  });

  it('(c) IPv6 Cloudflare edge is skipped', async () => {
    expect(await ipFor('172.21.0.1', '9.9.9.9, 203.0.113.7, 2606:4700::1')).toBe('203.0.113.7');
  });

  it('(d) IPv4-mapped gateway peer behaves like (a)', async () => {
    expect(await ipFor('::ffff:172.21.0.1', '9.9.9.9, 203.0.113.7, 162.158.1.1')).toBe('203.0.113.7');
  });

  it('(e) forged XFF starting with a Cloudflare address, untrusted peer: peer wins', async () => {
    expect(await ipFor('198.51.100.5', '162.158.1.1, 9.9.9.9')).toBe('198.51.100.5');
  });

  it('warnIfGatewayOutsideOwnNetwork is silent outside production and never throws', () => {
    const calls: string[] = [];
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    warnIfGatewayOutsideOwnNetwork({ warn: (_o, m) => calls.push(m) });
    expect(calls).toHaveLength(0);
    process.env['NODE_ENV'] = 'production';
    expect(() => warnIfGatewayOutsideOwnNetwork({ warn: (_o, m) => calls.push(m) })).not.toThrow();
    process.env['NODE_ENV'] = prev;
  });
});
