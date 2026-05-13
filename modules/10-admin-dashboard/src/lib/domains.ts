// Domain slug → display name mapping.
// Backend returns raw question_packs.domain slug values verbatim (decision db020d1).
// Frontend maps to human-readable display names here.
// Add new domains here as they are introduced in the catalog.

export const DOMAIN_LABELS: Record<string, string> = {
  cognitive:   "Cognitive",
  technical:   "Technical",
  personality: "Personality",
  language:    "Language",
  sales:       "Sales",
  custom:      "Custom",
  cloud:       "Cloud",
  security:    "Security",
  data:        "Data",
  leadership:  "Leadership",
  unknown:     "Other",
};

export function domainLabel(slug: string): string {
  return DOMAIN_LABELS[slug] ?? capitalize(slug);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
