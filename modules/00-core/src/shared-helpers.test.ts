import { describe, expect, it } from "vitest";
import { isUuid, assertUuid } from "./ids.js";
import { parsePagination } from "./pagination.js";
import { sha256Hex, hmacSha256Hex, timingSafeEqualStr } from "./hash.js";
import { escapeHtml, csvCell } from "./escape.js";

describe("ids", () => {
  it("isUuid accepts valid and rejects invalid", () => {
    expect(isUuid("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isUuid("0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
  it("assertUuid returns the value or throws", () => {
    const u = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(assertUuid(u)).toBe(u);
    expect(() => assertUuid("x", "tenantId")).toThrow(/tenantId must be a UUID/);
  });
});

describe("parsePagination", () => {
  it("defaults to page 1, pageSize 20", () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 20 });
  });
  it("rejects pageSize above the default max (100)", () => {
    expect(() => parsePagination({ pageSize: "101" })).toThrow(/between 1 and 100/);
    expect(parsePagination({ pageSize: "100" }).pageSize).toBe(100);
  });
  it("accepts an explicit max of 500", () => {
    expect(parsePagination({ pageSize: "500" }, { max: 500 }).pageSize).toBe(500);
    expect(() => parsePagination({ pageSize: "501" }, { max: 500 })).toThrow(/between 1 and 500/);
  });
  it("rejects bad page", () => {
    expect(() => parsePagination({ page: "0" })).toThrow(/page must be/);
  });
});

describe("hash", () => {
  it("sha256Hex known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });
  it("hmacSha256Hex known vector (RFC 4231 case 2)", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
  it("timingSafeEqualStr equal / unequal / different length", () => {
    expect(timingSafeEqualStr("secret", "secret")).toBe(true);
    expect(timingSafeEqualStr("secret", "secreT")).toBe(false);
    expect(timingSafeEqualStr("secret", "secret-longer")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("x", "")).toBe(false);
  });
});

describe("escape", () => {
  it("escapeHtml escapes & < > \" '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  it("csvCell formula guard for = + - @ and normal value", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(" =1+1")).toBe("' =1+1");
    expect(csvCell("\n=1")).toBe(`"'\n=1"`);
    expect(csvCell("=1")).toBe("'=1");
    expect(csvCell("\u200B=1+1")).toBe("'\u200B=1+1");
    expect(csvCell("\uFEFF=1+1")).toBe("'\uFEFF=1+1");
    expect(csvCell("\u2060@x")).toBe("'\u2060@x");
    expect(csvCell("1+1")).toBe("1+1");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});
