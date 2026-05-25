// AssessIQ — modules/18-certification/src/pdf/render.ts
//
// Renders a Certificate row to a PDF buffer using playwright-core + system
// Chromium. The import is lazy so a missing Chromium binary does not crash
// the API process on startup — the error surfaces only when a PDF is requested.
//
// Chromium path: process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium'.
// This matches the Hostinger VPS path where chromium-browser is installed via apt.
//
// A4 landscape = 297mm × 210mm. Playwright uses format:'A4' + landscape:true;
// the @page CSS rule in the template sets the matching page size so headers and
// footers align.
//
// The browser.close() call is in a `finally` block to prevent Chromium zombie
// processes if setContent or pdf() throw.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { Certificate } from '../types.js';
import { credentialQrDataUrl } from './qr.js';
import { renderCertificateHtml } from './template.js';

function getPublicBaseUrl(): string {
  const url = process.env['PUBLIC_BASE_URL'];
  if (!url) {
    throw new Error('PUBLIC_BASE_URL env var is required for PDF QR code generation');
  }
  return url.replace(/\/$/, ''); // strip trailing slash
}

async function launchBrowser() {
  // Lazy import — resolves only at call time so startup doesn't fail when
  // playwright-core is absent (e.g. in unit-test environments that mock this fn).
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

/**
 * Render a certificate to a PDF buffer.
 *
 * Throws if:
 *   - PUBLIC_BASE_URL env var is unset
 *   - playwright-core is not installed or Chromium is not found at the
 *     configured path
 *
 * The caller (HTTP route) maps any error to a 500 response.
 */
export async function renderCertificatePdf(cert: Certificate, orgName?: string): Promise<Buffer> {
  const verifyUrl = `${getPublicBaseUrl()}/verify/${cert.credential_id}`;
  const qrDataUrl = await credentialQrDataUrl(verifyUrl);
  const html = renderCertificateHtml(cert, qrDataUrl, verifyUrl, orgName);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // waitUntil: 'networkidle' is the playwright API (not 'networkidle0' which is puppeteer-only).
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
