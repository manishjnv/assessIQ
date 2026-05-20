// Status enum → human label + Chip variant.
// Centralizes the mapping so admin list and detail pages render statuses
// identically. Pages should never display the raw enum (PENDING_ADMIN_GRADING)
// to operators — that's content, not chrome.

import type { ChipVariant } from "@assessiq/ui-system";

export interface StatusDisplay {
  label: string;
  variant: ChipVariant;
}

const ATTEMPT_STATUS: Record<string, StatusDisplay> = {
  submitted:              { label: "Submitted",       variant: "accent" },
  auto_submitted:         { label: "Auto-submitted",  variant: "warn" },
  pending_admin_grading:  { label: "Pending grading", variant: "accent" },
  graded:                 { label: "Graded",          variant: "success" },
  released:               { label: "Released",        variant: "default" },
};

export function attemptStatusDisplay(status: string): StatusDisplay {
  return ATTEMPT_STATUS[status] ?? { label: humanize(status), variant: "default" };
}

const PACK_STATUS: Record<string, StatusDisplay> = {
  draft:     { label: "Draft",     variant: "accent" },
  published: { label: "Published", variant: "success" },
  archived:  { label: "Archived",  variant: "default" },
};

export function packStatusDisplay(status: string): StatusDisplay {
  return PACK_STATUS[status] ?? { label: humanize(status), variant: "default" };
}

function humanize(slug: string): string {
  if (!slug) return slug;
  const spaced = slug.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
