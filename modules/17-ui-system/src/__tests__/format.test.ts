import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatRelative, formatMonthYear } from "../format.js";

const d = new Date(2026, 3, 29, 14, 32);
const now = new Date(2026, 3, 29, 15, 0, 0);

describe("format", () => {
  it("formats date and datetime", () => {
    expect(formatDate(d)).toBe("Apr 29, 2026");
    expect(formatDateTime(d)).toBe("Apr 29, 2026 · 14:32");
    expect(formatMonthYear(d)).toBe("Apr 2026");
  });
  it("relative", () => {
    const ago = (ms: number) => formatRelative(new Date(now.getTime() - ms), now);
    expect(ago(4000)).toBe("4s ago");
    expect(ago(2 * 60000)).toBe("2 min ago");
    expect(ago(3 * 3600000)).toBe("3 h ago");
    expect(formatRelative(new Date(2026, 3, 28, 12), now)).toBe("Yesterday");
    expect(formatRelative(new Date(2026, 3, 24, 12), now)).toBe("5 days ago");
    expect(formatRelative(new Date(2026, 3, 21, 12), now)).toBe("Apr 21");
    expect(formatRelative(new Date(2025, 3, 21, 12), now)).toBe("Apr 21, 2025");
  });
  it("null/invalid", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatRelative("nope")).toBe("—");
  });
});
