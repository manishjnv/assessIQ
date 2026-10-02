import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "@assessiq/core";
import { encrypt, decrypt } from "../webhooks/crypto.js";

const mutable = config as unknown as Record<string, string | undefined>;
const ORIGINAL_KEY = mutable["ASSESSIQ_MASTER_KEY"]!;
const b64 = () => randomBytes(32).toString("base64");
function setKeys(current: string, previous?: string): void {
  mutable["ASSESSIQ_MASTER_KEY"] = current;
  mutable["ASSESSIQ_MASTER_KEY_PREVIOUS"] = previous;
}
afterEach(() => setKeys(ORIGINAL_KEY, undefined));

describe("webhook secret decrypt dual-key (E8)", () => {
  const OLD = b64();
  const NEW = b64();

  it("old-key ciphertext decrypts with MASTER_KEY=new + PREVIOUS=old", () => {
    setKeys(OLD);
    const c = encrypt("hook");
    setKeys(NEW, OLD);
    expect(decrypt(c)).toBe("hook");
  });

  it("without a previous key an old-key ciphertext still fails", () => {
    setKeys(OLD);
    const c = encrypt("hook");
    setKeys(NEW);
    expect(() => decrypt(c)).toThrow();
  });

  it("tampered ciphertext fails under both keys", () => {
    setKeys(OLD);
    const c = encrypt("hook");
    c[30] = c[30]! ^ 0xff;
    setKeys(NEW, OLD);
    expect(() => decrypt(c)).toThrow();
  });
});
