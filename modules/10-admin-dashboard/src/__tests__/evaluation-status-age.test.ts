// FU-C1: the "oldest waiting" age text on the Evaluation status page.
import { describe, it, expect } from "vitest";
import { waitingAge } from "../pages/grading-jobs.js";

describe("waitingAge", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("uses minutes under an hour, hours under two days, then days", () => {
    expect(waitingAge("2026-10-06T11:59:00Z", now)).toBe("1 minute");
    expect(waitingAge("2026-10-06T09:30:00Z", now)).toBe("2 hours");
    expect(waitingAge("2026-10-03T12:00:00Z", now)).toBe("3 days");
  });
  it("never goes negative for a clock skew", () => {
    expect(waitingAge("2026-10-06T12:05:00Z", now)).toBe("0 minutes");
  });
});
