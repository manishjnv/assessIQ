import { describe, it, expect } from "vitest";
import { uuidv7, shortId } from "../ids.js";

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CROCKFORD_ALPHABET = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
const FORBIDDEN_CHARS = new Set(["I", "L", "O", "U"]);

describe("uuidv7()", () => {
  it("returns a string matching the UUIDv7 format", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_V7_REGEX);
  });

  it("generates 1000 unique UUIDv7 values", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    const unique = new Set(ids);
    expect(unique.size).toBe(1000);
  });

  it("generates monotonically non-decreasing IDs in a tight loop", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    const sorted = [...ids].sort();
    // UUIDv7 is timestamp-prefixed and lexicographically sortable;
    // sorted order must match generation order (ties allowed within same ms)
    expect(ids).toEqual(sorted);
  });
});

describe("shortId()", () => {
  it("returns a 12-character string", () => {
    const id = shortId();
    expect(id).toHaveLength(12);
  });

  it("contains only Crockford base32 characters", () => {
    for (let i = 0; i < 100; i++) {
      const id = shortId();
      for (const char of id) {
        expect(CROCKFORD_ALPHABET.has(char)).toBe(true);
      }
    }
  });

  it("never contains I, L, O, or U (excluded Crockford chars)", () => {
    for (let i = 0; i < 1000; i++) {
      const id = shortId();
      for (const char of id) {
        expect(FORBIDDEN_CHARS.has(char)).toBe(false);
      }
    }
  });

  it("generates at least 9990 unique values out of 10 000 iterations", () => {
    const ids = Array.from({ length: 10_000 }, () => shortId());
    const unique = new Set(ids);
    // 60-bit uniform space: collision probability for 10k draws is negligible
    expect(unique.size).toBeGreaterThanOrEqual(9990);
  });
});
