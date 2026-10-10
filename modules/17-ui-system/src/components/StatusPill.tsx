// AssessIQ — StatusPill: a status string rendered as a Chip.
// Kit gap: no StatusPill recipe; built on Chip.
import React from "react";
import { Chip } from "./Chip.js";
import type { ChipVariant } from "./Chip.js";

export interface StatusPillProps {
  status: string;
  /** Maps a raw status to display text. */
  labels?: Record<string, string>;
  tone?: ChipVariant;
  /** Explicit text; wins over `labels`. */
  label?: string;
}

export function StatusPill({ status, labels, tone = "default", label }: StatusPillProps): React.ReactElement {
  return <Chip variant={tone}>{label ?? labels?.[status] ?? status}</Chip>;
}
StatusPill.displayName = "StatusPill";
