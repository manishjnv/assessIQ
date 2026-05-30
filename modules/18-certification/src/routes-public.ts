// AssessIQ — modules/18-certification/src/routes-public.ts
//
// Phase 5 Session 3 — public verify page routes (no auth, no tenant context).
// Phase 5 Session 7 — OG/Twitter meta tags + PNG OG image for LinkedIn.
//
// Routes:
//   GET /verify/:credentialId        → HTML page (green ✓ / red ✗ badge)
//   GET /verify/:credentialId/og.svg → OG image SVG for Twitter/Facebook (1200×630)
//   GET /verify/:credentialId/og.png → OG image PNG for LinkedIn (1200×630)
//
// Design decisions:
//   - Routes are mounted OUTSIDE /api/, OUTSIDE auth middleware, OUTSIDE tenant
//     middleware. The global tenantContextMiddleware auto-skips when
//     req.session?.tenantId is undefined — no carve-out needed.
//   - HMAC timingSafeEqual on every render (plan §15 trap #1 — `==` is a
//     timing oracle; must use verifyCertificateSignature which uses
//     crypto.timingSafeEqual on equal-length Buffers).
//   - Revoked certificates render a red revoked badge — NOT a 404.
//     Recruiters must be able to see that a credential was revoked, not think
//     it never existed.
//   - In-memory fixed-window rate limiter: 60 req/IP/hour, cap 10 000 entries.
//     Created fresh per registerVerifyRoutes() call so tests get isolation.
//   - Per-(IP, credentialId) view dedup: 1 h window, 50 000 entry cap.
//   - Counter increment (verification_views) is fire-and-forget via a separate
//     withTenant() transaction. The RLS UPDATE policy requires app.current_tenant
//     which is NOT set in withPublicVerifyContext. Analytics are non-critical;
//     losing an increment is acceptable.
//   - Cache-Control: no-cache on HTML (signature may change after tier upgrade).
//     Cache-Control: public, max-age=3600 on SVG/PNG (stable for an hour).
//   - PNG renderer: @resvg/resvg-js (pure-Rust, no Chromium). LinkedIn does not
//     render SVG previews; the PNG endpoint is what their crawler fetches.
//   - OG meta tags use absolute URLs derived from PUBLIC_BASE_URL. If unset
//     (test env), meta tags are silently omitted rather than crashing the page.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import { Resvg } from '@resvg/resvg-js';
import type { FastifyInstance } from 'fastify';
import { withTenant, getTenantById } from '@assessiq/tenancy';
import { ERASED_CANDIDATE_LABEL } from '@assessiq/core';

import { getCertSigningSecret, verifyCertificateSignature } from './crypto.js';
import {
  findByCredentialIdPublic,
  incrementCounter,
  withPublicVerifyContext,
} from './repository.js';
import type { Certificate } from './types.js';
import { CREDENTIAL_ID_REGEX } from './types.js';

// ---------------------------------------------------------------------------
// Erasure helper — looks up users.erased_at for a candidate using the cert's
// tenant context (withTenant sets app.current_tenant, satisfying RLS). The
// tenantId comes from cert.tenant_id at the call site. Returns false when
// the user row is not found (tolerate orphaned certs gracefully).
// ---------------------------------------------------------------------------

async function isCandidateErased(tenantId: string, candidateId: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<{ erased_at: string | null }>(
      `SELECT erased_at FROM users WHERE id = $1 LIMIT 1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row !== undefined && row.erased_at !== null;
  });
}

// ---------------------------------------------------------------------------
// Rate limiter (fixed window, in-memory)
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_CAP = 10_000;

function createRateLimiter() {
  const buckets = new Map<string, RateLimitBucket>();

  return function checkRateLimit(ip: string): boolean {
    const now = Date.now();

    if (buckets.size >= RATE_LIMIT_CAP) {
      // Evict all stale entries to reclaim memory before rejecting.
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
          buckets.delete(key);
        }
      }
      // If still at cap after eviction, reject to prevent unbounded growth.
      if (buckets.size >= RATE_LIMIT_CAP) {
        return false;
      }
    }

    const bucket = buckets.get(ip);
    if (bucket === undefined || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      buckets.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= RATE_LIMIT_MAX) {
      return false;
    }

    bucket.count++;
    return true;
  };
}

// ---------------------------------------------------------------------------
// View dedup (per IP + credentialId, 1 h window)
// ---------------------------------------------------------------------------

const VIEW_DEDUP_WINDOW_MS = 60 * 60 * 1000;
const VIEW_DEDUP_CAP = 50_000;

function createViewDedup() {
  const seen = new Map<string, number>();

  return function shouldCountView(ip: string, credentialId: string): boolean {
    const key = `${ip}:${credentialId}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < VIEW_DEDUP_WINDOW_MS) {
      return false;
    }
    // Evict stale entries when approaching cap.
    if (seen.size >= VIEW_DEDUP_CAP) {
      for (const [k, ts] of seen) {
        if (now - ts >= VIEW_DEDUP_WINDOW_MS) {
          seen.delete(k);
        }
      }
    }
    seen.set(key, now);
    return true;
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

type CertStatus = 'valid' | 'tampered' | 'revoked';

interface VerifyPageData {
  status: CertStatus;
  cert: Certificate;
  /** Issuing organization (tenant/company) name. AssessIQ is the platform. */
  orgName?: string | undefined;
  /** True when the certificate holder has exercised DPDP right to erasure. */
  isErased?: boolean | undefined;
}

function renderVerifyPage(data: VerifyPageData): string {
  const { status, cert, orgName, isErased } = data;
  const issuedBy =
    orgName !== undefined && orgName.trim().length > 0
      ? `${escHtml(orgName.trim())} &middot; via AssessIQ`
      : 'AssessIQ';

  const statusLabel =
    status === 'valid'
      ? '✓ Verified'
      : status === 'revoked'
        ? '✗ Revoked'
        : '✗ Invalid Signature';

  // DPDP: when erased, set JSON-LD about.name to ERASED_CANDIDATE_LABEL
  // ("Erased candidate") rather than omitting the field entirely — omission
  // would break the schema type contract for EducationalOccupationalCredential.
  const jsonLd =
    status === 'valid'
      ? `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'EducationalOccupationalCredential',
          name: cert.course_title,
          credentialCategory: cert.tier,
          identifier: cert.credential_id,
          issuedBy: { '@type': 'Organization', name: 'AssessIQ' },
          about: { '@type': 'Person', name: isErased ? ERASED_CANDIDATE_LABEL : cert.display_name },
          dateCreated: cert.issued_at,
        })}</script>`
      : '';

  const ogMeta = renderOgMeta(cert, status);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Certificate Verification — AssessIQ</title>
  <!-- Privacy: candidate verify pages are NOT bulk-indexed by search engines —
       each shows a person's name + result, and §10 (SEO_Strategy) mandates
       opt-in only. The page stays public-by-URL for on-demand verification, and
       LinkedIn/OG sharing is UNAFFECTED (social crawlers ignore robots noindex;
       it only opts the page out of Google's/Bing's search index). -->
  <meta name="robots" content="noindex,follow" />
  ${ogMeta}
  ${jsonLd}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1); padding: 2.5rem 3rem; max-width: 540px; width: 100%; }
    .badge { display: inline-flex; align-items: center; gap: .5rem; padding: .5rem 1.25rem; border-radius: 9999px; font-weight: 600; font-size: 1rem; margin-bottom: 1.5rem; }
    .cert-status--valid { background: #dcfce7; color: #166534; }
    .cert-status--revoked { background: #fee2e2; color: #991b1b; }
    .cert-status--tampered { background: #fee2e2; color: #991b1b; }
    .field { margin-bottom: .75rem; }
    .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
    .value { font-size: 1rem; color: #111827; font-weight: 500; }
    .credential-id { font-family: monospace; font-size: .9rem; background: #f3f4f6; padding: .25rem .5rem; border-radius: 4px; }
    .share-linkedin { display: inline-flex; align-items: center; gap: .5rem; margin-top: 1.5rem; padding: .625rem 1.25rem; border-radius: 6px; border: 1.5px solid #0a66c2; background: #fff; color: #0a66c2; font-size: .9rem; font-weight: 600; text-decoration: none; font-family: system-ui, sans-serif; cursor: pointer; }
    .share-linkedin:hover { background: #f0f6ff; }
    .share-linkedin--disabled { opacity: .4; cursor: not-allowed; border-color: #9ca3af; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge cert-status--${status}">${statusLabel}</span>
    <div class="field">
      <p class="label">Credential ID</p>
      <p class="value credential-id">${escHtml(cert.credential_id)}</p>
    </div>
    <div class="field">
      <p class="label">Name</p>
      ${isErased
        ? `<p class="value" style="color:#6b7280;font-style:italic;">Holder has exercised right to erasure; name withheld.</p>`
        : `<p class="value">${escHtml(cert.display_name)}</p>`
      }
    </div>
    <div class="field">
      <p class="label">Course</p>
      <p class="value">${escHtml(cert.course_title)}</p>
    </div>
    <div class="field">
      <p class="label">Issued by</p>
      <p class="value">${issuedBy}</p>
    </div>
    <div class="field">
      <p class="label">Level</p>
      <p class="value">${escHtml(cert.level)}</p>
    </div>
    <div class="field">
      <p class="label">Tier</p>
      <p class="value">${escHtml(cert.tier)}</p>
    </div>
    <div class="field">
      <p class="label">Issued</p>
      <p class="value">${escHtml(cert.issued_at)}</p>
    </div>
    ${
      status === 'revoked'
        ? `<div class="field">
      <p class="label">Revoked</p>
      <p class="value">${escHtml(cert.revoked_at ?? '')}${cert.revoke_reason ? ` — ${escHtml(cert.revoke_reason)}` : ''}</p>
    </div>`
        : ''
    }
    ${renderShareSection(cert, status)}
  </div>
</body>
</html>`;
}

function renderNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Certificate Not Found — AssessIQ</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1); padding: 2.5rem 3rem; max-width: 540px; width: 100%; text-align: center; }
    h1 { font-size: 1.5rem; color: #111827; margin-bottom: .75rem; }
    p { color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Certificate Not Found</h1>
    <p>No certificate matching that credential ID could be found. Please double-check the ID and try again.</p>
  </div>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// OG / Twitter meta tags (HTML head fragment)
// ---------------------------------------------------------------------------
//
// LinkedIn / Twitter / Facebook crawlers read these tags to build link
// previews. Without them, shared URLs render as plain title-only cards.
//
// Image strategy:
//   - og:image points at the PNG endpoint (LinkedIn does NOT render SVG)
//   - twitter:image points at the same PNG (covers all crawlers in one tag set)
//
// PUBLIC_BASE_URL is required for absolute URLs (crawlers don't resolve
// relative paths). If unset (test env), this function returns an empty string
// rather than crashing — the page still renders, the previews degrade.

function renderOgMeta(cert: Certificate, status: CertStatus): string {
  const baseUrl = process.env['PUBLIC_BASE_URL'];
  if (!baseUrl || baseUrl.length === 0) {
    return '';
  }
  const trimmed = baseUrl.replace(/\/+$/, '');
  const pageUrl = `${trimmed}/verify/${cert.credential_id}`;
  const imageUrl = `${trimmed}/verify/${cert.credential_id}/og.png`;

  const title =
    status === 'valid'
      ? `${cert.display_name} — ${cert.course_title}`
      : status === 'revoked'
        ? `Revoked credential — ${cert.credential_id}`
        : `Invalid credential — ${cert.credential_id}`;
  const description =
    status === 'valid'
      ? `Verified ${cert.tier} credential issued by AssessIQ — ${cert.course_title} (${cert.level}).`
      : status === 'revoked'
        ? `This credential has been revoked by the issuer.`
        : `This credential's signature could not be verified.`;

  return [
    `<meta property="og:title" content="${escAttr(title)}" />`,
    `<meta property="og:description" content="${escAttr(description)}" />`,
    `<meta property="og:url" content="${escAttr(pageUrl)}" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:site_name" content="AssessIQ" />`,
    `<meta property="og:image" content="${escAttr(imageUrl)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escAttr(title)}" />`,
    `<meta name="twitter:description" content="${escAttr(description)}" />`,
    `<meta name="twitter:image" content="${escAttr(imageUrl)}" />`,
  ].join('\n  ');
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// OG SVG rendering (1200×630)
// ---------------------------------------------------------------------------

function renderOgSvg(cert: Certificate, status: CertStatus): string {
  // sRGB colours derived from OKLCH hue 258 palette (matches AssessIQ brand).
  const bgColor = status === 'valid' ? '#1e3a5f' : '#5f1e1e';
  const badgeColor = status === 'valid' ? '#22c55e' : '#ef4444';
  const badgeText =
    status === 'valid' ? 'VERIFIED' : status === 'revoked' ? 'REVOKED' : 'INVALID';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="${bgColor}"/>
  <rect x="60" y="60" width="300" height="48" rx="24" fill="${badgeColor}"/>
  <text x="210" y="93" font-family="Newsreader, Georgia, serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${badgeText}</text>
  <text x="60" y="210" font-family="Newsreader, Georgia, serif" font-size="64" font-weight="700" fill="#fff">${escSvg(cert.display_name)}</text>
  <text x="60" y="290" font-family="system-ui, sans-serif" font-size="32" fill="rgba(255,255,255,0.8)">${escSvg(cert.course_title)}</text>
  <text x="60" y="340" font-family="system-ui, sans-serif" font-size="28" fill="rgba(255,255,255,0.6)">${escSvg(cert.level)} · ${escSvg(cert.tier)}</text>
  <text x="60" y="540" font-family="system-ui, sans-serif" font-size="22" fill="rgba(255,255,255,0.5)">${escSvg(cert.credential_id)}</text>
  <text x="1140" y="540" font-family="system-ui, sans-serif" font-size="22" fill="rgba(255,255,255,0.5)" text-anchor="end">AssessIQ</text>
</svg>`;
}

function escSvg(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// OG PNG rendering (1200×630, rasterized from the SVG via resvg)
// ---------------------------------------------------------------------------
//
// LinkedIn requires PNG/JPEG for OG previews (SVG is rejected). resvg-js is
// pure-Rust (no Chromium), ~10ms per render. fitTo width=1200 produces a
// 1200×630 PNG matching the SVG viewBox.

function renderOgPng(cert: Certificate, status: CertStatus): Buffer {
  const svg = renderOgSvg(cert, status);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

// ---------------------------------------------------------------------------
// Status determination (shared by HTML, OG SVG, OG PNG routes)
// ---------------------------------------------------------------------------

function determineStatus(cert: Certificate): CertStatus {
  if (cert.revoked_at !== null) {
    return 'revoked';
  }
  const secret = getCertSigningSecret();
  const valid = verifyCertificateSignature(
    {
      id: cert.id,
      tenant_id: cert.tenant_id,
      attempt_id: cert.attempt_id,
      candidate_id: cert.candidate_id,
      template_key: cert.template_key,
      credential_id: cert.credential_id,
      tier: cert.tier,
      display_name: cert.display_name,
      course_title: cert.course_title,
      level: cert.level,
      issued_at: cert.issued_at,
    },
    cert.signed_hash,
    secret,
  );
  return valid ? 'valid' : 'tampered';
}

// ---------------------------------------------------------------------------
// LinkedIn share section (HTML fragment rendered inside the verify card)
// ---------------------------------------------------------------------------
//
// Visible for ACTIVE certs only; disabled for REVOKED; omitted for TAMPERED
// (tampered certs should not be promoted) and when PUBLIC_BASE_URL is unset.
// No JS required — pure <a> / <button disabled> HTML. The share URL uses the
// LinkedIn share-offsite pattern (no Company Page or API auth needed).

function renderShareSection(cert: Certificate, status: CertStatus): string {
  if (status === 'tampered') return '';
  const baseUrl = process.env['PUBLIC_BASE_URL'];
  if (!baseUrl || baseUrl.length === 0) return '';

  const trimmed = baseUrl.replace(/\/+$/, '');
  const verifyUrl = `${trimmed}/verify/${cert.credential_id}`;
  const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(verifyUrl)}`;

  // Inline SVG so the page has no external asset dependency.
  const icon =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" ` +
    `fill="currentColor" aria-hidden="true" style="flex-shrink:0">` +
    `<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>` +
    `<rect x="2" y="9" width="4" height="12" rx="1"/>` +
    `<circle cx="4" cy="4" r="2"/></svg>`;

  if (status === 'valid') {
    return (
      `<a href="${escAttr(shareUrl)}" target="_blank" rel="noopener noreferrer" ` +
      `class="share-linkedin" data-help-id="public.verify.share_linkedin">` +
      `${icon} Share on LinkedIn</a>`
    );
  }

  // revoked — disabled button with tooltip
  return (
    `<button disabled class="share-linkedin share-linkedin--disabled" ` +
    `title="Revoked certificates can&#39;t be shared" ` +
    `data-help-id="public.verify.share_linkedin">` +
    `${icon} Share on LinkedIn</button>`
  );
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerVerifyRoutes(app: FastifyInstance): Promise<void> {
  const checkRateLimit = createRateLimiter();
  const shouldCountView = createViewDedup();

  // -------------------------------------------------------------------------
  // GET /verify/:credentialId — HTML verify page
  // -------------------------------------------------------------------------
  app.get<{ Params: { credentialId: string } }>(
    '/verify/:credentialId',
    async (req, reply) => {
      const ip = req.ip;
      const rawId = req.params.credentialId;

      // Reject malformed IDs before touching the DB.
      if (!CREDENTIAL_ID_REGEX.test(rawId.toUpperCase())) {
        return reply
          .code(404)
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .send(renderNotFoundPage());
      }

      // Per-IP rate limit.
      if (!checkRateLimit(ip)) {
        return reply.code(429).send({ error: 'Too Many Requests' });
      }

      const credentialId = rawId.toUpperCase();

      const cert = await withPublicVerifyContext(async (client) =>
        findByCredentialIdPublic(client, credentialId),
      );

      if (cert === null) {
        return reply
          .code(404)
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .send(renderNotFoundPage());
      }

      const status = determineStatus(cert);

      // Fire-and-forget view counter increment (separate tenant-scoped tx).
      // Promise.resolve() wraps the call so .catch() is safe even if withTenant
      // returns undefined in test environments where the mock is reset.
      if (shouldCountView(ip, cert.credential_id)) {
        void Promise.resolve(
          withTenant(cert.tenant_id, async (client) => {
            await incrementCounter(client, cert.id, 'verification_views');
          }),
        ).catch(() => {});
      }

      // Issuing organization (tenant/company) name. Best-effort; falls back to
      // "AssessIQ" in the template if the lookup fails. getTenantById opens its
      // own withTenant for cert.tenant_id, so it resolves cross-tenant here.
      let orgName: string | undefined;
      try {
        orgName = (await getTenantById(cert.tenant_id)).name;
      } catch {
        orgName = undefined;
      }

      // DPDP erasure: check whether the certificate holder has been erased.
      // The HMAC snapshot (signed_hash payload) is NOT altered — verification
      // still works on the stored display_name. Only the rendered card changes.
      // Best-effort: if the lookup fails, treat as not erased (safe default —
      // the name shown is what was already public on the cert).
      let isErased = false;
      try {
        isErased = await isCandidateErased(cert.tenant_id, cert.candidate_id);
      } catch {
        isErased = false;
      }

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(renderVerifyPage({ status, cert, orgName, isErased }));
    },
  );

  // -------------------------------------------------------------------------
  // GET /verify/:credentialId/og.svg — OG image for LinkedIn previews
  // -------------------------------------------------------------------------
  app.get<{ Params: { credentialId: string } }>(
    '/verify/:credentialId/og.svg',
    async (req, reply) => {
      const rawId = req.params.credentialId;

      if (!CREDENTIAL_ID_REGEX.test(rawId.toUpperCase())) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      const credentialId = rawId.toUpperCase();

      const cert = await withPublicVerifyContext(async (client) =>
        findByCredentialIdPublic(client, credentialId),
      );

      if (cert === null) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      const status = determineStatus(cert);

      return reply
        .code(200)
        .header('content-type', 'image/svg+xml')
        .header('cache-control', 'public, max-age=3600')
        // X-Robots-Tag noindex: the image bakes in the candidate's name + result,
        // so keep it out of image search (the HTML verify page is noindex too).
        // Social unfurlers ignore this header, so LinkedIn/OG previews still work.
        .header('x-robots-tag', 'noindex')
        .send(renderOgSvg(cert, status));
    },
  );

  // -------------------------------------------------------------------------
  // GET /verify/:credentialId/og.png — PNG OG image for LinkedIn (Session 7)
  // -------------------------------------------------------------------------
  // LinkedIn's crawler rejects SVG previews. This endpoint rasterizes the
  // same SVG via resvg (pure-Rust, no Chromium). Cache for 1 hour — the
  // certificate identity fields are stable; tier upgrades re-render via
  // cache expiry rather than purging.
  app.get<{ Params: { credentialId: string } }>(
    '/verify/:credentialId/og.png',
    async (req, reply) => {
      const rawId = req.params.credentialId;

      if (!CREDENTIAL_ID_REGEX.test(rawId.toUpperCase())) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      const credentialId = rawId.toUpperCase();

      const cert = await withPublicVerifyContext(async (client) =>
        findByCredentialIdPublic(client, credentialId),
      );

      if (cert === null) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      const status = determineStatus(cert);
      const png = renderOgPng(cert, status);

      return reply
        .code(200)
        .header('content-type', 'image/png')
        .header('cache-control', 'public, max-age=3600')
        // X-Robots-Tag noindex: keep the candidate-PII share image out of image
        // search. LinkedIn/social crawlers ignore it, so previews still render.
        .header('x-robots-tag', 'noindex')
        .send(png);
    },
  );
}
