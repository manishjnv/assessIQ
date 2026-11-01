import { describe, it, expect } from "vitest";
import { formatIst, formatIstOr } from "../time.js";
import { ValidationError } from "../errors.js";

describe("formatIst()", () => {
  it("formats a morning UTC instant in Indian time", () => {
    expect(formatIst("2026-11-08T04:02:44Z")).toBe("8 Nov 2026, 9:32 am IST");
  });

  it("moves to the next IST day across midnight", () => {
    expect(formatIst("2026-11-08T19:00:00Z")).toBe("9 Nov 2026, 12:30 am IST");
  });

  it("uses pm and a 12-hour clock in the afternoon", () => {
    expect(formatIst("2026-11-08T09:05:00Z")).toBe("8 Nov 2026, 2:35 pm IST");
  });

  it("accepts a Date object", () => {
    expect(formatIst(new Date("2026-11-08T04:02:44Z"))).toBe("8 Nov 2026, 9:32 am IST");
  });

  it("throws ValidationError for an invalid string or Date", () => {
    expect(() => formatIst("not a date")).toThrow(ValidationError);
    expect(() => formatIst(new Date("x"))).toThrow(ValidationError);
  });
});

describe("formatIstOr()", () => {
  it("formats a valid instant the same as formatIst", () => {
    expect(formatIstOr("2026-11-08T18:45:00Z")).toBe("9 Nov 2026, 12:15 am IST");
    expect(formatIstOr(new Date("2026-11-08T04:02:44Z"))).toBe("8 Nov 2026, 9:32 am IST");
  });

  it("returns the raw input for an invalid string instead of throwing", () => {
    expect(formatIstOr("not a date")).toBe("not a date");
  });

  it("returns String(input) for an invalid Date instead of throwing", () => {
    expect(formatIstOr(new Date("x"))).toBe("Invalid Date");
  });
});
