import { describe, it, expect } from "vitest";
import type { NavigatorItem } from "../components/QuestionNavigator.js";
import { neighbor, matchesFilter, filterCounts, filterSuffix } from "../components/navigatorFilter.js";

// q1 answered, q2 open+flagged (current), q3 answered+flagged, q4 open, q5 answered
const item = (n: number, answered: boolean, flagged: boolean, cur = false): NavigatorItem => ({
  questionId: `q${n}`,
  position: n,
  status: cur ? "current" : flagged ? "flagged" : answered ? "answered" : "unanswered",
  answered,
  flagged,
});
const items = [item(1, true, false), item(2, false, true, true), item(3, true, true), item(4, false, false), item(5, true, false)];
const ids = (x: NavigatorItem | null): string | null => (x === null ? null : x.questionId);

describe("navigatorFilter", () => {
  it("all: plain neighbour, no wrap", () => {
    expect(ids(neighbor(items, "q2", 1, "all"))).toBe("q3");
    expect(ids(neighbor(items, "q2", -1, "all"))).toBe("q1");
    expect(ids(neighbor(items, "q1", -1, "all"))).toBeNull();
    expect(ids(neighbor(items, "q5", 1, "all"))).toBeNull();
  });

  it("filtered: skips non-matches", () => {
    expect(ids(neighbor(items, "q2", 1, "answered"))).toBe("q3");
    expect(ids(neighbor(items, "q3", 1, "answered"))).toBe("q5");
    expect(ids(neighbor(items, "q5", -1, "open"))).toBe("q4");
  });

  it("filtered: wraps at both ends", () => {
    expect(ids(neighbor(items, "q5", 1, "answered"))).toBe("q1");
    expect(ids(neighbor(items, "q1", -1, "answered"))).toBe("q5");
    expect(ids(neighbor(items, "q4", 1, "open"))).toBe("q2");
  });

  it("current outside the filter: jumps to the next match from its place", () => {
    // q2 is open, not answered: Next in "answered" goes to q3, Previous to q1.
    expect(ids(neighbor(items, "q2", 1, "answered"))).toBe("q3");
    expect(ids(neighbor(items, "q2", -1, "answered"))).toBe("q1");
    // q4 is not flagged: Next flagged wraps to q2, Previous flagged is q3.
    expect(ids(neighbor(items, "q4", 1, "flagged"))).toBe("q2");
    expect(ids(neighbor(items, "q4", -1, "flagged"))).toBe("q3");
  });

  it("empty filter or only the current question matches: null", () => {
    const none = items.map((i) => ({ ...i, flagged: false, status: "unanswered" as const }));
    expect(neighbor(none, "q2", 1, "flagged")).toBeNull();
    const one = items.map((i) => ({ ...i, flagged: i.questionId === "q2" }));
    expect(neighbor(one, "q2", 1, "flagged")).toBeNull();
  });

  it("unknown current id: starts from the list edge", () => {
    expect(ids(neighbor(items, "zz", 1, "open"))).toBe("q2");
    expect(ids(neighbor(items, "zz", -1, "open"))).toBe("q4");
    expect(neighbor(items, "zz", 1, "all")).toBeNull();
  });

  it("counts and match rules use answered and flagged, not the square status", () => {
    expect(filterCounts(items)).toEqual({ all: 5, answered: 3, flagged: 2, open: 2 });
    expect(matchesFilter(items[1]!, "flagged")).toBe(true); // current square, still flagged
    expect(matchesFilter(items[2]!, "answered")).toBe(true); // flagged square, still answered
  });

  it("footer suffix", () => {
    expect(filterSuffix("all")).toBe("");
    expect(filterSuffix("flagged")).toBe(" flagged");
    expect(filterSuffix("open")).toBe(" open");
    expect(filterSuffix("answered")).toBe(" answered");
  });
});
