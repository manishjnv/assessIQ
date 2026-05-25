// AssessIQ — modules/18-certification/src/pdf/template.ts
//
// A4 landscape HTML template for certificate PDFs. Self-contained (inline CSS,
// no network fetches — Chromium renders offline with --no-sandbox).
//
// Layout follows conventional professional-credential composition (Coursera /
// AWS / university-diploma style): a framed page, CENTERED and vertically
// balanced, with the recipient name as the visual centerpiece, an official
// verification seal (inline SVG — no font-glyph dependency), an authorized-
// issuer signature line, and a QR + verify URL footer.
//
// Brand tokens: OKLCH hue 258 palette → sRGB, light mode. Tier accent:
// completion=blue, distinction=gold, honors=violet (branding gap per SKILL.md).
// Font stacks fall back to Georgia/Helvetica/Arial (Liberation fonts are
// installed in the api image) since Newsreader/Geist aren't on the VPS Chromium.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { Certificate } from '../types.js';

// ---------------------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------------------

const FG_PRIMARY = '#1a1a1a';
const FG_SECONDARY = '#5f6368';
const FG_MUTED = '#8a8f98';
const BG_BASE = '#ffffff';
const BORDER = '#e2e2e2';

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
 * deployment (no hardcoded host). Text is selectable (not SVG) except the seal.
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

  // Inline SVG check — vector, so it renders without any installed font glyph
  // (the previous &#10003; entity tofu'd as a missing-glyph box on the VPS).
  const checkSvg = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Certificate — ${escHtml(cert.credential_id)}</title>
  <style>
    @page { size: 297mm 210mm; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 297mm; height: 210mm; background: ${BG_BASE}; overflow: hidden; }
    body { font-family: ${FONT_SANS}; color: ${FG_PRIMARY}; position: relative; }

    /* Framed page — bold accent rule + thin inner rule. */
    .frame { position: absolute; inset: 8mm; border: 3px solid ${accent}; }
    .inner {
      position: absolute;
      inset: 12mm;
      border: 1px solid ${BORDER};
      padding: 12mm 20mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    /* Header — centered brand wordmark + rule. */
    .brand {
      font-family: ${FONT_SANS};
      font-size: 16pt;
      font-weight: 800;
      letter-spacing: 0.32em;
      color: ${accent};
      padding-left: 0.32em; /* offset trailing letter-spacing for true centering */
    }
    .brand-sub {
      font-family: ${FONT_SANS};
      font-size: 7.5pt;
      font-weight: 600;
      letter-spacing: 0.22em;
      color: ${FG_MUTED};
      text-transform: uppercase;
      margin-top: 1mm;
    }
    .title {
      font-family: ${FONT_SERIF};
      font-size: 21pt;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: ${FG_PRIMARY};
      margin-top: 7mm;
    }
    .title-rule {
      width: 34mm;
      height: 2px;
      background: ${accent};
      margin: 3mm 0 0;
    }

    /* Body — grows to fill the page so the composition is vertically centered. */
    .body {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3mm;
      width: 100%;
    }
    .cert-label {
      font-family: ${FONT_SANS};
      font-size: 9.5pt;
      color: ${FG_SECONDARY};
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .recipient-name {
      font-family: ${FONT_SERIF};
      font-size: 42pt;
      font-weight: 700;
      color: ${FG_PRIMARY};
      line-height: 1.05;
    }
    .name-rule { width: 120mm; max-width: 70%; height: 1px; background: ${BORDER}; }
    .awarded { font-family: ${FONT_SANS}; font-size: 11pt; color: ${FG_SECONDARY}; }
    .course-title {
      font-family: ${FONT_SERIF};
      font-size: 22pt;
      font-weight: 600;
      color: ${accent};
      line-height: 1.15;
    }
    .meta {
      font-family: ${FONT_SANS};
      font-size: 9.5pt;
      color: ${FG_SECONDARY};
      letter-spacing: 0.04em;
      margin-top: 1mm;
    }
    .meta b { color: ${FG_PRIMARY}; font-weight: 600; }

    /* Footer — signature (left) · seal (center) · QR + verify (right). */
    .footer {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .col { display: flex; flex-direction: column; gap: 1.5mm; }
    .col-left { align-items: flex-start; text-align: left; }
    .col-center { align-items: center; }
    .col-right { align-items: flex-end; text-align: right; }

    .sign-line { width: 56mm; border-bottom: 1px solid ${FG_PRIMARY}; margin-bottom: 1mm; }
    .sign-label { font-family: ${FONT_SANS}; font-size: 8.5pt; color: ${FG_SECONDARY}; }
    .sign-sub { font-family: ${FONT_SANS}; font-size: 7.5pt; color: ${FG_MUTED}; }

    .seal {
      width: 30mm;
      height: 30mm;
      border: 2px solid ${accent};
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5mm;
      position: relative;
    }
    .seal::after {
      content: '';
      position: absolute;
      inset: 1.5mm;
      border: 1px solid ${accent};
      border-radius: 50%;
      opacity: 0.5;
    }
    .seal-text {
      font-family: ${FONT_SANS};
      font-size: 5.5pt;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: ${accent};
      text-align: center;
      line-height: 1.25;
    }

    .qr img { width: 22mm; height: 22mm; display: block; }
    .verify-line { font-family: ${FONT_SANS}; font-size: 7.5pt; color: ${FG_SECONDARY}; line-height: 1.5; }
    .cred-id { font-family: ${FONT_MONO}; font-size: 7pt; color: ${FG_MUTED}; }
  </style>
</head>
<body>
  <div class="frame"></div>
  <div class="inner">
    <div class="brand">ASSESSIQ</div>
    <div class="brand-sub">Skills Assessment Platform</div>
    <div class="title">Certificate of Completion</div>
    <div class="title-rule"></div>

    <div class="body">
      <div class="cert-label">This is to certify that</div>
      <div class="recipient-name">${escHtml(cert.display_name)}</div>
      <div class="name-rule"></div>
      <div class="awarded">has successfully completed the assessment</div>
      <div class="course-title">${escHtml(cert.course_title)}</div>
      <div class="meta">
        Level <b>${escHtml(cert.level)}</b> &nbsp;&middot;&nbsp; <b>${tierLabel}</b> &nbsp;&middot;&nbsp; Issued <b>${escHtml(issuedDate)}</b>
      </div>
    </div>

    <div class="footer">
      <div class="col col-left">
        <div class="sign-line"></div>
        <div class="sign-label">AssessIQ</div>
        <div class="sign-sub">Authorized Issuer</div>
      </div>

      <div class="col col-center">
        <div class="seal">
          ${checkSvg}
          <div class="seal-text">Verified<br/>Credential</div>
        </div>
      </div>

      <div class="col col-right">
        <div class="qr"><img src="${qrDataUrl}" alt="Verify QR code" /></div>
        <div class="verify-line">Scan or visit ${verifyDisplay}</div>
        <div class="cred-id">${escHtml(cert.credential_id)}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
