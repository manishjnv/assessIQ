import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(key: string | Buffer, input: string | Buffer): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

/**
 * Constant-time string equality. Both sides are hashed to fixed 32-byte digests
 * first, so timing depends on neither input length nor secret length (no
 * length oracle; same construction as the original 01-auth client-ip helper).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  // An empty (unset) secret must never match, even against another empty string.
  if (a === "" || b === "") return false;
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
