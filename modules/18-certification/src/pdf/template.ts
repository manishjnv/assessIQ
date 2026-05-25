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

const FG_PRIMARY = '#1a1a1a';
const FG_SECONDARY = '#5f6368';
const BG_BASE = '#ffffff';
const BG_RAISED = '#fafafa';
const BORDER = '#e8e8e8';

// Tier-specific accent. Completion = brand blue; distinction = gold (matches the
// admin tier chip #d97706); honors = violet. Branding gap noted in SKILL.md.
const TIER_ACCENT: Record<string, string> = {
  completion: '#3177dc',
  distinction: '#b8860b',
  honors: '#7c3aed',
};

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
 * `verifyUrl` is the canonical public verification URL (also encoded in the QR);
 * it is derived from PUBLIC_BASE_URL, so the printed domain always matches the
 * deployment (no hardcoded host). Text is selectable (not SVG).
 */
export function renderCertificateHtml(cert: Certificate, qrDataUrl: string, verifyUrl: string): string {
  const issuedDate = new Date(cert.issued_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const tierLabel = escHtml(cert.tier.charAt(0).toUpperCase() + cert.tier.slice(1));
  const accent = TIER_ACCENT[cert.tier] ?? TIER_ACCENT['completion']!;
  const verifyDisplay = escHtml(verifyUrl.replace(/^https?:\/\//, ''));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Certificate — ${escHtml(cert.credential_id)}</title>
  <style>
    @page { size: 297mm 210mm; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 297mm; height: 210mm; background: ${BG_BASE}; overflow: hidden; }
    body { font-family: ${FONT_SANS}; color: ${FG_PRIMARY}; }

    /* Framed border — outer accent rule + thin inner rule (classic certificate). */
    .frame {
      position: absolute;
      inset: 7mm;
      border: 2.5px solid ${accent};
      padding: 4mm;
    }
    .inner {
      position: absolute;
      inset: 0;
      margin: 4mm;
      border: 1px solid ${BORDER};
      padding: 12mm 16mm;
      display: flex;
      flex-direction: column;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 9mm;
    }
    .wordmark { display: flex; flex-direction: column; gap: 1mm; }
    .brand {
      font-family: ${FONT_SANS};
      font-size: 15pt;
      font-weight: 800;
      letter-spacing: 0.14em;
      color: ${accent};
    }
    .issuer {
      font-family: ${FONT_SANS};
      font-size: 8.5pt;
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
      font-size: 36pt;
      font-weight: 700;
      color: ${FG_PRIMARY};
      line-height: 1.1;
      margin-bottom: 3mm;
    }
    .awarded {
      font-family: ${FONT_SANS};
      font-size: 10pt;
      color: ${FG_SECONDARY};
      margin-bottom: 2mm;
    }
    .course-title {
      font-family: ${FONT_SERIF};
      font-size: 18pt;
      color: ${accent};
      margin-bottom: 5mm;
    }
    .meta-row { display: flex; gap: 10mm; margin-bottom: 5mm; }
    .meta-item { font-family: ${FONT_SANS}; font-size: 10pt; color: ${FG_SECONDARY}; }
    .meta-value { font-weight: 600; color: ${FG_PRIMARY}; }
    .tier-badge {
      align-self: flex-start;
      background: ${accent};
      color: #fff;
      font-family: ${FONT_SANS};
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1.5mm 5mm;
      border-radius: 999px;
    }

    /* Verification seal — top-right of the inner frame, out of normal flow. */
    .seal {
      position: absolute;
      top: 12mm;
      right: 16mm;
      width: 26mm;
      height: 26mm;
      border: 2px solid ${accent};
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5mm;
      color: ${accent};
    }
    .seal .check { font-size: 15pt; font-weight: 700; line-height: 1; }
    .seal .seal-text {
      font-family: ${FONT_SANS};
      font-size: 6pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: center;
    }

    .footer {
      margin-top: auto;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .sign { display: flex; flex-direction: column; gap: 1.5mm; }
    .sign-line { width: 60mm; border-bottom: 1px solid ${FG_PRIMARY}; }
    .sign-label { font-family: ${FONT_SANS}; font-size: 8.5pt; color: ${FG_SECONDARY}; }
    .verify { display: flex; align-items: flex-end; gap: 4mm; }
    .verify-text {
      text-align: right;
      font-family: ${FONT_SANS};
      font-size: 7.5pt;
      color: ${FG_SECONDARY};
      line-height: 1.5;
      padding-bottom: 1mm;
    }
    .qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 1mm; }
    .qr-wrap img { width: 22mm; height: 22mm; }
    .qr-label { font-family: ${FONT_SANS}; font-size: 7pt; color: ${FG_SECONDARY}; }
  </style>
</head>
<body>
  <div class="frame"></div>
  <div class="inner">
    <div class="header">
      <div class="wordmark">
        <span class="brand">ASSESSIQ</span>
        <span class="issuer">Certificate of ${tierLabel}</span>
      </div>
      <span class="credential-id">${escHtml(cert.credential_id)}</span>
    </div>

    <p class="cert-label">This is to certify that</p>
    <p class="recipient-name">${escHtml(cert.display_name)}</p>
    <p class="awarded">has successfully completed</p>
    <p class="course-title">${escHtml(cert.course_title)}</p>

    <div class="meta-row">
      <span class="meta-item">Level:&nbsp;<span class="meta-value">${escHtml(cert.level)}</span></span>
      <span class="meta-item">Issued:&nbsp;<span class="meta-value">${escHtml(issuedDate)}</span></span>
    </div>

    <span class="tier-badge">${tierLabel}</span>

    <div class="seal">
      <span class="check">&#10003;</span>
      <span class="seal-text">Verified<br/>Credential</span>
    </div>

    <div class="footer">
      <div class="sign">
        <div class="sign-line"></div>
        <div class="sign-label">AssessIQ &middot; Authorized Issuer</div>
      </div>
      <div class="verify">
        <div class="verify-text">Verify this credential at<br/>${verifyDisplay}</div>
        <div class="qr-wrap">
          <img src="${qrDataUrl}" alt="Verify QR code" />
          <span class="qr-label">Scan to verify</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
