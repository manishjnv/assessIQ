import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sealTagLast, openTagLast } from "@assessiq/core/aes-gcm";

// AES-256-GCM envelope shape: nonce(12) || ciphertext || authTag(16).
// All AssessIQ-encrypted secrets at rest (TOTP secrets, embed signing keys)
// use this envelope. Implementation lives in @assessiq/core (aes-gcm.ts); this
// file keeps the historical names. Master key + rotation fallback: see there.
export function encryptEnvelope(plaintext: Buffer | string): Buffer {
  return sealTagLast(plaintext);
}

export function decryptEnvelope(envelope: Buffer): Buffer {
  return openTagLast(envelope);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// Constant-time equality. Returns false (without timing leak) on length
// mismatch — the timingSafeEqual primitive itself throws on length mismatch.
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 43-char base64url string (32 bytes of entropy = 256 bits). Used for
// session cookies and magic-link tokens. Never logged in plaintext.
export function randomTokenBase64Url(byteLen = 32): string {
  return randomBytes(byteLen).toString("base64url");
}

// Base62 encoding of `byteLen` random bytes. For 32 bytes the output is
// 43 chars (256/log2(62) ≈ 43.0). Used for API keys (`aiq_live_<43-char>`).
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomTokenBase62(byteLen = 32): string {
  const bytes = randomBytes(byteLen);
  let n = 0n;
  for (const byte of bytes) {
    n = (n << 8n) + BigInt(byte);
  }
  let out = "";
  while (n > 0n) {
    const idx = Number(n % 62n);
    out = BASE62_ALPHABET[idx]! + out;
    n /= 62n;
  }
  // Pad with leading '0' so length is deterministic (matters for the
  // key_prefix slice used for admin display).
  const expectedLen = Math.ceil((byteLen * 8) / Math.log2(62));
  while (out.length < expectedLen) out = "0" + out;
  return out;
}
