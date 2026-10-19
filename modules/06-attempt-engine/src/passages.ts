// EXP-8: passage-aware draw. A passage is shared stem text used by several question rows.
// The draw works on "units": a standalone question, or all pool members of one passage in a fixed order.
// Pure; no I/O. Callers pass the passage facts read from `questions` (see repo.listPassageInfo).

export interface PassageFact {
  passageId: string;
  /** passage_position, null = not set. */
  position: number | null;
  /** questions.created_at in ms, the tie-break after position. */
  createdAt: number;
}

export type PassageInfo = ReadonlyMap<string, PassageFact>;

function byFixedOrder(info: PassageInfo) {
  return (a: { id: string }, b: { id: string }): number => {
    const x = info.get(a.id)!;
    const y = info.get(b.id)!;
    return (x.position ?? Infinity) - (y.position ?? Infinity) || x.createdAt - y.createdAt || (a.id < b.id ? -1 : 1);
  };
}

/** Units in order of first appearance; the members of a passage stay together in fixed order. */
export function groupUnits<T extends { id: string }>(picks: readonly T[], info: PassageInfo): T[][] {
  const units: T[][] = [];
  const byPassage = new Map<string, T[]>();
  for (const p of picks) {
    const f = info.get(p.id);
    if (f === undefined) {
      units.push([p]);
    } else if (byPassage.has(f.passageId)) {
      byPassage.get(f.passageId)!.push(p);
    } else {
      const u = [p];
      byPassage.set(f.passageId, u);
      units.push(u);
    }
  }
  for (const u of byPassage.values()) u.sort(byFixedOrder(info));
  return units;
}

/**
 * First n slots from `picks` (already shuffled or ordered by the caller), whole units only.
 * A passage counts as its number of children. A unit that does not fit the remaining slots is
 * skipped whole and later, smaller units may fill the gap. The result can be shorter than n.
 * With no passage facts this is exactly picks.slice(0, n).
 */
export function takeUnits<T extends { id: string }>(picks: readonly T[], n: number, info: PassageInfo): T[] {
  if (info.size === 0) return picks.slice(0, n);
  const out: T[] = [];
  for (const u of groupUnits(picks, info)) {
    if (out.length + u.length <= n) out.push(...u);
    if (out.length === n) break;
  }
  return out;
}
