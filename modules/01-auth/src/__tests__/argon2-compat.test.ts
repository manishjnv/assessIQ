// N10: argon2 0.40 -> 0.45 compatibility. No database. Fixture input is not a secret.
// Options mirror ARGON2_OPTS in ../totp.ts — keep in sync.
import * as argon2 from "argon2";
import { describe, expect, it } from "vitest";

const INPUT = "N10-compat-check-0001";
// Produced by argon2 0.40.3 with the totp.ts options.
const HASH_040 =
  "$argon2id$v=19$m=65536,t=3,p=4$5JFkAFKXG+9cSK9kJKDq4g$uLr58otZf7tcTKKDxyWuS1PvQ5dzHGWHogrZX0FPLRM";

describe("argon2 compat (0.40 hash vs installed version)", () => {
  it("verifies a 0.40 hash", async () => {
    expect(await argon2.verify(HASH_040, INPUT)).toBe(true);
  });

  it("rejects a wrong input", async () => {
    expect(await argon2.verify(HASH_040, "N10-compat-check-0002")).toBe(false);
  });

  it("new hash has the same parameter prefix", async () => {
    const h = await argon2.hash(INPUT, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });
    // 0.45 writes the params as m,p,t (0.40: m,t,p). Compare as sets, not strings.
    const prefix = (s: string): string => {
      const [, alg, v, params] = s.split("$");
      return `${alg}|${v}|${params!.split(",").sort().join(",")}`;
    };
    expect(prefix(h)).toBe(prefix(HASH_040));
  });
});
