// AssessIQ — modules/18-certification/src/pdf/template.ts
//
// A4 landscape HTML template for certificate PDFs.
// All styles are inline (no external fetches — Chromium runs with --no-sandbox
// and cannot reach the network in the production render path).
//
// Brand tokens: OKLCH hue 258 palette → sRGB, locked to light mode.
// See docs/10-branding-guideline.md § 13.b for the canonical hex values.
// Tier-specific accent colours are NOT defined in the branding guideline;
// all tiers use the same accent (#3177dc). Gap documented in SKILL.md § PDF
// generation.
//
// Font stacks: Newsreader / Geist may not be installed on the VPS system
// Chromium. Fallbacks (Georgia, Helvetica) are baked into every OS and are
// sufficient for a readable, on-brand output. See SKILL.md § PDF generation
// for the known gap.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { Certificate } from '../types.js';

// ---------------------------------------------------------------------------
// Brand tokens (sRGB — from OKLCH hue 258 palette)
// ---------------------------------------------------------------------------

const ACCENT = '#3177dc';
const FG_PRIMARY = '#1a1a1a';
const FG_SECONDARY = '#5f6368';
const BG_BASE = '#ffffff';
const BG_RAISED = '#fafafa';
const BORDER = '#e8e8e8';

const FONT_SERIF = "Newsreader, Georgia, 'Times New Roman', serif";
const FONT_SANS = 'Geist, Helvetica, Arial, sans-serif';
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * Renders the certificate as a self-contained A4 landscape HTML document.
 * `qrDataUrl` must be a PNG data URL produced by credentialQrDataUrl().
 * Text is selectable (not SVG).
 */
export function renderCertificateHtml(cert: Certificate, qrDataUrl: string): string {
  const issuedDate = new Date(cert.issued_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const tierLabel = escHtml(cert.tier.charAt(0).toUpperCase() + cert.tier.slice(1));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Certificate — ${escHtml(cert.credential_id)}</title>
  <style>
    @page { size: 297mm 210mm; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 297mm; height: 210mm; background: ${BG_BASE}; overflow: hidden; }
    body {
      font-family: ${FONT_SANS};
      color: ${FG_PRIMARY};
      display: flex;
      flex-direction: column;
      padding: 18mm 22mm 14mm 30mm;
      position: relative;
    }
    .accent-bar {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 8mm;
      background: ${ACCENT};
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 7mm;
    }
    .issuer {
      font-family: ${FONT_SANS};
      font-size: 9pt;
      color: ${FG_SECONDARY};
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .credential-id {
      font-family: ${FONT_MONO};
      font-size: 8pt;
      color: ${FG_SECONDARY};
      background: ${BG_RAISED};
      border: 1px solid ${BORDER};
      padding: 1mm 2.5mm;
      border-radius: 3px;
    }
    .cert-label {
      font-family: ${FONT_SANS};
      font-size: 9pt;
      color: ${FG_SECONDARY};
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 2mm;
    }
    .recipient-name {
      font-family: ${FONT_SERIF};
      font-size: 34pt;
      font-weight: 700;
      color: ${FG_PRIMARY};
      line-height: 1.1;
      margin-bottom: 5mm;
    }
    .course-title {
      font-family: ${FONT_SERIF};
      font-size: 16pt;
      color: ${ACCENT};
      margin-bottom: 4mm;
    }
    .meta-row {
      display: flex;
      gap: 10mm;
      margin-bottom: 5mm;
    }
    .meta-item {
      font-family: ${FONT_SANS};
      font-size: 10pt;
      color: ${FG_SECONDARY};
    }
    .meta-value {
      font-weight: 600;
      color: ${FG_PRIMARY};
    }
    .tier-badge {
      display: inline-block;
      background: ${ACCENT};
      color: #fff;
      font-family: ${FONT_SANS};
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1mm 4mm;
      border-radius: 999px;
    }
    .footer {
      position: absolute;
      bottom: 10mm;
      left: 30mm;
      right: 18mm;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .issued-line {
      font-family: ${FONT_SANS};
      font-size: 8pt;
      color: ${FG_SECONDARY};
    }
    .qr-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1mm;
    }
    .qr-wrap img { width: 22mm; height: 22mm; }
    .qr-label {
      font-family: ${FONT_SANS};
      font-size: 7pt;
      color: ${FG_SECONDARY};
    }
  </style>
</head>
<body>
  <div class="accent-bar"></div>

  <div class="header">
    <span class="issuer">AssessIQ · Certificate of Completion</span>
    <span class="credential-id">${escHtml(cert.credential_id)}</span>
  </div>

  <p class="cert-label">This is to certify that</p>
  <p class="recipient-name">${escHtml(cert.display_name)}</p>
  <p class="course-title">${escHtml(cert.course_title)}</p>

  <div class="meta-row">
    <span class="meta-item">Level:&nbsp;<span class="meta-value">${escHtml(cert.level)}</span></span>
    <span class="meta-item">Issued:&nbsp;<span class="meta-value">${escHtml(issuedDate)}</span></span>
  </div>

  <span class="tier-badge">${tierLabel}</span>

  <div class="footer">
    <p class="issued-line">Verify at assessiq.automateedge.cloud/verify/${escHtml(cert.credential_id)}</p>
    <div class="qr-wrap">
      <img src="${qrDataUrl}" alt="Verify QR code" />
      <span class="qr-label">Scan to verify</span>
    </div>
  </div>
</body>
</html>`;
}
