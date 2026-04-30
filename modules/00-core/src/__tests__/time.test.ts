import { describe, it, expect } from "vitest";
import { nowIso, parseIso } from "../time.js";
import { ValidationError } from "../errors.js";

const ISO_Z_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("nowIso()", () => {
  it("returns a string ending in Z", () => {
    const result = nowIso();
    expect(result.endsWith("Z")).toBe(true);
  });

  it("returns a string matching ISO 8601 UTC format", () => {
    const result = nowIso();
    expect(result).toMatch(ISO_Z_REGEX);
  });

  it("returns a parseable date that is close to the current time", () => {
    const before = Date.now();
    const result = nowIso();
    const after = Date.now();
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("parseIso()", () => {
  it("parses a valid UTC ISO string into a Date", () => {
    const d = parseIso("2026-04-30T12:00:00.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it("round-trips a UTC ISO string via toISOString()", () => {
    const input = "2026-04-30T12:00:00.000Z";
    const d = parseIso(input);
    expect(d.toISOString()).toBe(input);
  });

  it("throws ValidationError for a local-timezone string (no Z suffix)", () => {
    expect(() => parseIso("2026-04-30T12:00:00+05:30")).toThrow(ValidationError);
  });

  it("throws ValidationError for an unparseable string", () => {
    expect(() => parseIso("not-a-date")).toThrow(ValidationError);
  });

  it("throws ValidationError for an empty string", () => {
    expect(() => parseIso("")).toThrow(ValidationError);
  });

  it("throws ValidationError for a string with UTC offset notation instead of Z", () => {
    expect(() => parseIso("2026-04-30T12:00:00+00:00")).toThrow(ValidationError);
  });

  it("accepts strings with millisecond precision", () => {
    const d = parseIso("2026-04-30T12:00:00.123Z");
    expect(d.getMilliseconds()).toBe(123);
  });

  it("accepts strings without milliseconds (bare Z)", () => {
    const d = parseIso("2026-04-30T12:00:00Z");
    expect(d.getSeconds()).toBe(0);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
