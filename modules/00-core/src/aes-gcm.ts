import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

// ONE AES-256-GCM implementation keyed by ASSESSIQ_MASTER_KEY (+ _PREVIOUS for
// rotation). Two STORED layouts exist and must both stay readable byte for byte:
//   TagLast: nonce(12) || ciphertext || tag(16)  — TOTP secrets, embed secret_enc
//   TagMid:  iv(12) || tag(16) || ciphertext     — webhook_endpoints.secret_enc
// Keys are read at call time (tests swap config in place).

const IV_LEN = 12;
const TAG_LEN = 16;

type Layout = "last" | "mid";

function seal(plaintext: Buffer | string, layout: Layout): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.ASSESSIQ_MASTER_KEY, "base64"), iv);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return layout === "last" ? Buffer.concat([iv, ct, tag]) : Buffer.concat([iv, tag, ct]);
}

function openWithKey(buf: Buffer, key: Buffer, layout: Layout): Buffer {
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("envelope too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = layout === "last" ? buf.subarray(buf.length - TAG_LEN) : buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = layout === "last" ? buf.subarray(IV_LEN, buf.length - TAG_LEN) : buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Master-key rotation (E8): current key first, then ASSESSIQ_MASTER_KEY_PREVIOUS.
// GCM auth makes a wrong key throw, so the fallback can never return wrong plaintext.
function open(buf: Buffer, layout: Layout): Buffer {
  try {
    return openWithKey(buf, Buffer.from(config.ASSESSIQ_MASTER_KEY, "base64"), layout);
  } catch (err) {
    const prev = config.ASSESSIQ_MASTER_KEY_PREVIOUS;
    if (!prev) throw err;
    return openWithKey(buf, Buffer.from(prev, "base64"), layout);
  }
}

export const sealTagLast = (plaintext: Buffer | string): Buffer => seal(plaintext, "last");
export const openTagLast = (buf: Buffer): Buffer => open(buf, "last");
export const sealTagMid = (plaintext: Buffer | string): Buffer => seal(plaintext, "mid");
export const openTagMid = (buf: Buffer): Buffer => open(buf, "mid");
