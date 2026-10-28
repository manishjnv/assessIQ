// Z-169: the navigator filter drives Previous, Next, the arrow keys and the footer label.
// Pure functions only (no React) so the wrap rules can be unit tested.
import type { NavigatorItem } from "./QuestionNavigator.js";

export type NavigatorFilter = "all" | "answered" | "flagged" | "open";

/** Footer wording for the active filter: "Next", "Next flagged", "Next open", "Next answered". */
export function filterSuffix(filter: NavigatorFilter): string {
  return filter === "all" ? "" : ` ${filter}`;
}

/** Answered means a non-null answer, even when the square shows "current" or "flagged". */
export function isAnswered(item: NavigatorItem): boolean {
  return item.answered ?? item.status === "answered";
}

export function isFlagged(item: NavigatorItem): boolean {
  return item.flagged ?? item.status === "flagged";
}

export function matchesFilter(item: NavigatorItem, filter: NavigatorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "answered") return isAnswered(item);
  if (filter === "flagged") return isFlagged(item);
  return !isAnswered(item);
}

export function filterCounts(items: NavigatorItem[]): Record<NavigatorFilter, number> {
  return {
    all: items.length,
    answered: items.filter((i) => matchesFilter(i, "answered")).length,
    flagged: items.filter((i) => matchesFilter(i, "flagged")).length,
    open: items.filter((i) => matchesFilter(i, "open")).length,
  };
}

/**
 * The question Previous (dir -1) or Next (dir 1) goes to.
 * - filter "all": the plain neighbour, no wrap (null at either end), as before Z-169.
 * - any other filter: the next match in `dir`, wrapping round. The current question may be
 *   outside the filter; the search then starts from its place in the list. The current
 *   question is never returned. Null when nothing else matches (empty filter).
 */
export function neighbor(
  items: NavigatorItem[],
  currentId: string,
  dir: 1 | -1,
  filter: NavigatorFilter,
): NavigatorItem | null {
  const cur = items.findIndex((i) => i.questionId === currentId);
  if (filter === "all") {
    const next = items[cur + dir];
    return cur === -1 || next === undefined ? null : next;
  }
  const n = items.length;
  const start = cur === -1 ? (dir === 1 ? -1 : n) : cur;
  for (let step = 1; step <= n; step++) {
    const item = items[(((start + dir * step) % n) + n) % n]!;
    if (item.questionId !== currentId && matchesFilter(item, filter)) return item;
  }
  return null;
}
