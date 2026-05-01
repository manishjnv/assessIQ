import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "@assessiq/core";

// AES-256-GCM envelope shape: nonce(12) || ciphertext || authTag(16).
// All AssessIQ-encrypted secrets at rest (TOTP secrets, embed signing keys,
// webhook secrets, future password hashes if applicable) use this envelope.
//
// Master key: ASSESSIQ_MASTER_KEY env var, 32 bytes base64-decoded.
// Validated at config load (modules/00-core/src/config.ts:is32ByteBase64).

const NONCE_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  // Decode on each call rather than at module load: respects test scenarios
  // that swap config via environment manipulation. The base64 decode is
  // cheap and the result is 32 bytes.
  return Buffer.from(config.ASSESSIQ_MASTER_KEY, "base64");
}

export function encryptEnvelope(plaintext: Buffer | string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decryptEnvelope(envelope: Buffer): Buffer {
  if (envelope.length < NONCE_LEN + TAG_LEN) {
    throw new Error("envelope too short");
  }
  const nonce = envelope.subarray(0, NONCE_LEN);
  const tag = envelope.subarray(envelope.length - TAG_LEN);
  const ct = envelope.subarray(NONCE_LEN, envelope.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
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
