// A1-7: explicit trusted-proxy list for Fastify `trustProxy` (replaces `true`, which let any
// peer forge req.ip through X-Forwarded-For).
// Gateway = assessiq-net gateway (subnet 172.21.0.0/16, checked on the VPS 2026-11-02): Caddy
// reaches the api from there. Cloudflare ranges: https://www.cloudflare.com/ips/ (2026-11-02),
// same as Caddy's global trusted_proxies (infra/caddyfile/cloudflare-ranges.txt).
// Do NOT trust 172.16.0.0/12: the VPS is shared with other apps.
import { networkInterfaces } from 'node:os';

const GATEWAY = '172.21.0.1/32';

export const TRUSTED_PROXIES: string[] = [
  GATEWAY,
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export const TRUSTED_GATEWAY = GATEWAY;

/** True when an IPv4 string lies in 172.21.0.0/16. */
function inGatewayNet(ip: string): boolean {
  return ip.startsWith('172.21.');
}

/**
 * Production only. Warns once when the container has no address in the gateway's /16: the
 * trusted gateway entry would then never match and req.ip would fall back to the proxy IP.
 * Never throws.
 */
export function warnIfGatewayOutsideOwnNetwork(log: { warn: (obj: object, msg: string) => void }): void {
  if (process.env['NODE_ENV'] !== 'production') return;
  try {
    const found = Object.values(networkInterfaces())
      .flat()
      .some((i) => i !== undefined && !i.internal && i.family === 'IPv4' && inGatewayNet(i.address));
    if (!found) {
      log.warn({}, `trustProxy: no container address in 172.21.0.0/16, gateway ${GATEWAY} will not match; req.ip may be the proxy IP (A1-7)`);
    }
  } catch {
    // never block boot
  }
}
