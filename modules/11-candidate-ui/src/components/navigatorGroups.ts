import type { NavigatorItem } from "./QuestionNavigator.js";

export interface NavigatorGroup {
  /** null = ungrouped (flat list, today's behaviour). */
  section: { index: number; name: string } | null;
  items: NavigatorItem[];
}

/**
 * Group navigator items by section, in first-appearance order. Items without a
 * section yield a single flat group, so unsectioned and per-section (one
 * section at a time) attempts render exactly as before.
 */
export function groupNavigatorItems(items: NavigatorItem[]): NavigatorGroup[] {
  if (!items.some((i) => i.section !== undefined)) return [{ section: null, items }];
  const groups: NavigatorGroup[] = [];
  for (const item of items) {
    const s = item.section ?? null;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.section?.index === s?.index) last.items.push(item);
    else groups.push({ section: s, items: [item] });
  }
  return groups;
}

export function countAnswered(items: NavigatorItem[]): number {
  return items.filter((i) => i.answered ?? i.status === "answered").length;
}
