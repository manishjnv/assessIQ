// Z-170: pure maths for the collapsed navigator rail (handoff README, "Collapsed rail").
// The list is translated so the current cell's centre sits at the centre of the view (the lens).

/** Scale by distance from the current cell: 0 (current), 1, 2, 3, 4 and further. */
export const RAIL_SCALE: readonly number[] = [1.16, 0.94, 0.88, 0.82, 0.78];
export const RAIL_OPACITY: readonly number[] = [1, 0.92, 0.62, 0.38, 0.2];

export function railDistanceStyle(distance: number): { scale: number; opacity: number } {
  const i = Math.min(Math.abs(distance), RAIL_SCALE.length - 1);
  return { scale: RAIL_SCALE[i]!, opacity: RAIL_OPACITY[i]! };
}

/**
 * Translate (px, along the rail axis) that centres a cell in the view:
 * viewSize / 2 - (cellStart + cellSize / 2). cellStart is the cell's offsetTop (or offsetLeft).
 */
export function lensOffset(viewSize: number, cellStart: number, cellSize: number): number {
  return viewSize / 2 - (cellStart + cellSize / 2);
}
