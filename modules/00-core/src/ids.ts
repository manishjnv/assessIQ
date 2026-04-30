import { randomBytes } from "node:crypto";
import { uuidv7 as uuidv7Impl } from "uuidv7";

/**
 * Returns a new UUIDv7 string (timestamp-prefixed, monotonically sortable).
 * Uses the `uuidv7` npm package — does NOT import node:crypto for UUID generation.
 */
export function uuidv7(): string {
  return uuidv7Impl();
}

/**
 * Crockford base32 alphabet — 32 characters, excludes I, L, O, U.
 * Each character maps to a 5-bit value (0–31).
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Returns a 12-character Crockford base32 ID backed by 60 bits of
 * cryptographic randomness (12 bytes, each masked to 5 bits; 256 % 32 = 0
 * so there is no modular bias).
 */
export function shortId(): string {
  const bytes = randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i++) {
    // .charAt() always returns string (vs [] which is string|undefined under
    // noUncheckedIndexedAccess); the index is masked into [0,31] which is
    // always in range.
    id += CROCKFORD.charAt(bytes[i]! & 0x1f);
  }
  return id;
}
