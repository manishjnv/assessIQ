import { Chip } from "./Chip.js";

export interface ErasedChipProps {
  className?: string;
}

/**
 * Inline chip shown next to a candidate name when the candidate has exercised
 * DPDP right-to-erasure (API returns `{ isErased: true }`).
 *
 * Composes <Chip variant="default"> — the grey/muted palette
 * (--aiq-color-bg-raised background, --aiq-color-fg-secondary text,
 * --aiq-color-border border) communicates "inert / gone" without introducing
 * any new color token.
 *
 * Intentionally has no icon, no tooltip, no animation. Dead simple.
 */
export function ErasedChip({ className }: ErasedChipProps): JSX.Element {
  return (
    <Chip variant="default" className={className}>
      Erased
    </Chip>
  );
}
