import { describe, it, expect, afterEach } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sealTagLast, openTagLast, sealTagMid, openTagMid } from "../aes-gcm.js";

const mutable = config as unknown as Record<string, string | undefined>;
const ORIGINAL = mutable["ASSESSIQ_MASTER_KEY"]!;
const KEY = Buffer.alloc(32, 7);
const OLD_KEY = Buffer.alloc(32, 9);
afterEach(() => {
  mutable["ASSESSIQ_MASTER_KEY"] = ORIGINAL;
  mutable["ASSESSIQ_MASTER_KEY_PREVIOUS"] = undefined;
});
const useKeys = (cur: Buffer, prev?: Buffer) => {
  mutable["ASSESSIQ_MASTER_KEY"] = cur.toString("base64");
  mutable["ASSESSIQ_MASTER_KEY_PREVIOUS"] = prev?.toString("base64");
};

// Reference encoders: verbatim copies of the pre-N24 encrypt bodies.
function refEnvelopeTagLast(plaintext: Buffer | string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}
function refWebhookTagMid(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}
function refEmbedBase64(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

describe("aes-gcm golden layouts", () => {
  it("opens legacy tag-last envelopes (01 TOTP / embed secret_enc)", () => {
    useKeys(KEY);
    expect(openTagLast(refEnvelopeTagLast("JBSWY3DPEHPK3PXP", KEY)).toString("utf8")).toBe("JBSWY3DPEHPK3PXP");
    expect(openTagLast(refEnvelopeTagLast("", KEY)).length).toBe(0);
  });
  it("opens legacy tag-mid envelopes (13 webhook secret_enc)", () => {
    useKeys(KEY);
    expect(openTagMid(refWebhookTagMid("whsec_ünï", KEY)).toString("utf8")).toBe("whsec_ünï");
    expect(openTagMid(refWebhookTagMid("", KEY)).length).toBe(0);
  });
  it("opens the 12-embed base64 output via openTagLast", () => {
    useKeys(KEY);
    const b64 = refEmbedBase64("hook-secret", KEY);
    expect(openTagLast(Buffer.from(b64, "base64")).toString("utf8")).toBe("hook-secret");
  });
  it("seal output matches the legacy layouts (raw node:crypto decrypt)", () => {
    useKeys(KEY);
    const last = sealTagLast("abc");
    const d1 = createDecipheriv("aes-256-gcm", KEY, last.subarray(0, 12));
    d1.setAuthTag(last.subarray(last.length - 16));
    expect(Buffer.concat([d1.update(last.subarray(12, last.length - 16)), d1.final()]).toString()).toBe("abc");
    const mid = sealTagMid(Buffer.from("xyz"));
    const d2 = createDecipheriv("aes-256-gcm", KEY, mid.subarray(0, 12));
    d2.setAuthTag(mid.subarray(12, 28));
    expect(Buffer.concat([d2.update(mid.subarray(28)), d2.final()]).toString()).toBe("xyz");
  });
  it("round-trips both layouts", () => {
    useKeys(KEY);
    expect(openTagLast(sealTagLast("a")).toString()).toBe("a");
    expect(openTagMid(sealTagMid("b")).toString()).toBe("b");
  });
  it("falls back to the previous key in both layouts; seal uses current only", () => {
    useKeys(OLD_KEY);
    const l = sealTagLast("one");
    const m = sealTagMid("two");
    useKeys(KEY, OLD_KEY);
    expect(openTagLast(l).toString()).toBe("one");
    expect(openTagMid(m).toString()).toBe("two");
    const fresh = sealTagLast("new");
    useKeys(KEY);
    expect(openTagLast(fresh).toString()).toBe("new");
    expect(() => openTagLast(l)).toThrow();
  });
  it("rejects tampered tag, tampered ciphertext, wrong layout and short input", () => {
    useKeys(KEY, OLD_KEY);
    const l = sealTagLast("x");
    l[l.length - 1] = l[l.length - 1]! ^ 1;
    expect(() => openTagLast(l)).toThrow();
    const m = sealTagMid("x");
    m[13] = m[13]! ^ 1;
    expect(() => openTagMid(m)).toThrow();
    expect(() => openTagMid(sealTagLast("some longer plaintext"))).toThrow();
    expect(() => openTagLast(Buffer.alloc(27))).toThrow("envelope too short");
  });
});
