// AssessIQ — modules/18-certification/src/pdf/qr.ts
//
// Generates a PNG QR code for a certificate verify URL, returned as a data URL
// suitable for embedding directly in an <img src=""> in the PDF template.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import QRCode from 'qrcode';

/**
 * Returns a PNG data URL for a QR code pointing at the given verify URL.
 * Error-correction level M (≈15% damage tolerance) per spec.
 */
export async function credentialQrDataUrl(verifyUrl: string): Promise<string> {
  return QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 1,
    width: 200,
  });
}
