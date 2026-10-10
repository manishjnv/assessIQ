import { randomBytes } from "node:crypto";
import { sealTagLast, openTagLast } from "@assessiq/core/aes-gcm";
import { sha256Hex, timingSafeEqualStr } from "@assessiq/core";

export { sha256Hex };

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

// Constant-time equality over bytes (latin1 maps each byte 1:1 to a char, so
// string equality == byte equality). Delegates to the shared hash-then-compare.
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return timingSafeEqualStr(a.toString("latin1"), b.toString("latin1"));
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
